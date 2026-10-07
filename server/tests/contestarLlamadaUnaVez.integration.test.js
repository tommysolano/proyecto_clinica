/**
 * Oct-2026: «a veces al contestar el sistema dice que el contacto colgó, pero al
 * contacto la llamada le sigue en curso y oye al asesor (el asesor no le oye)».
 *
 * Causa: dos «aceptar» de la misma llamada a la vez (doble toque mientras
 * conectaba, o el «Contestar» del aviso más el del panel). El primero conectaba
 * el audio en Meta; el segundo volvía con «el contacto colgó» y el navegador
 * cerraba la pantalla dejando viva la primera conexión.
 *
 * Ahora la llamada se RESERVA antes de hablar con Meta: solo un «aceptar» llega.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const llamadasAMeta = [];
let emitidos = [];

function installMock(request, exports) {
  const filename = require.resolve(request);
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const cuenta = { _id: 'cuenta-cloud', connectionType: 'cloud_api', phoneNumberId: 'pnid' };
installMock('../utils/whatsappGateway', {
  resolveAccountForConversation: async () => cuenta,
  getUsableAccount: async () => cuenta,
  cloudCreds: (a) => ({ phoneNumberId: a.phoneNumberId }),
});
installMock('../utils/whatsappCalls', {
  // Meta tarda un poco en confirmar: es la ventana en la que entraba el segundo.
  acceptCall: async (creds, callId) => {
    llamadasAMeta.push({ action: 'accept', callId });
    await new Promise((r) => setTimeout(r, 50));
    return { ok: true };
  },
  rejectCall: async (creds, callId) => { llamadasAMeta.push({ action: 'reject', callId }); return { ok: true }; },
  terminateCall: async (creds, callId) => { llamadasAMeta.push({ action: 'terminate', callId }); return { ok: true }; },
  parseCallEvent: require('../utils/whatsappCalls').parseCallEvent,
});
installMock('../realtime', {
  emitToCallCenter: (evento, payload) => emitidos.push({ evento, payload }),
  emitChatAssignment: () => {},
  emitToClinic: () => {},
  emitToUser: () => {},
  emitToRole: () => {},
});

const Call = require('../models/Call');
const Conversation = require('../models/Conversation');
const callController = require('../controllers/callController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => {
  await H.resetDb();
  llamadasAMeta.length = 0;
  emitidos = [];
});

async function sonando() {
  const clinicId = new H.mongoose.Types.ObjectId();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593999112233', channel: 'whatsapp' });
  const call = await Call.create({
    clinic: clinicId,
    conversation: conv._id,
    callId: `wacid.${Math.random().toString(36).slice(2)}`,
    direction: 'in',
    phone: conv.phone,
    status: 'ringing',
    offerSdp: 'v=0 offer',
  });
  return { clinicId, conv, call };
}

const contestar = (clinicId, userId, callId, nombre = 'Asesora') => {
  const req = H.mockReq(clinicId, userId, { sdp: 'v=0 answer' }, { role: 'call_center', params: { callId } });
  req.user.name = nombre;
  return H.runController(callController.acceptCall, req);
};

test('dos «Contestar» a la vez: solo uno llega a Meta y el otro no rompe la llamada', async () => {
  const { clinicId, call } = await sonando();
  const yo = new H.mongoose.Types.ObjectId();

  const [a, b] = await Promise.all([
    contestar(clinicId, yo, call.callId),
    contestar(clinicId, yo, call.callId),
  ]);

  const codigos = [a.statusCode, b.statusCode].sort();
  assert.deepEqual(codigos, [200, 409], JSON.stringify([a.payload, b.payload]));
  const rechazo = a.statusCode === 409 ? a : b;
  assert.match(rechazo.payload.message, /Ya estás contestando/);
  assert.equal(llamadasAMeta.filter((l) => l.action === 'accept').length, 1, 'Meta recibe UN solo aceptar');
  assert.equal(llamadasAMeta.filter((l) => l.action === 'terminate').length, 0, 'nadie cuelga la llamada buena');

  const final = await Call.findById(call._id);
  assert.equal(final.status, 'active');
  assert.equal(final.acceptingAt, null, 'la reserva se suelta al conectar');
});

test('si otro asesor ya está contestando, el segundo recibe un mensaje claro', async () => {
  const { clinicId, call } = await sonando();
  const ana = new H.mongoose.Types.ObjectId();
  const beto = new H.mongoose.Types.ObjectId();
  const [a, b] = await Promise.all([
    contestar(clinicId, ana, call.callId, 'Ana'),
    contestar(clinicId, beto, call.callId, 'Beto'),
  ]);
  const rechazo = [a, b].find((r) => r.statusCode === 409);
  assert.ok(rechazo, 'uno de los dos se rechaza');
  assert.match(rechazo.payload.message, /Otro asesor está contestando/);
  assert.equal(llamadasAMeta.filter((l) => l.action === 'accept').length, 1);

  // Ya conectada, un tercer intento dice quién la tiene.
  const tarde = await contestar(clinicId, new H.mongoose.Types.ObjectId(), call.callId);
  assert.equal(tarde.statusCode, 409);
  assert.match(tarde.payload.message, /ya la contestó (Ana|Beto)/);
});

test('una reserva abandonada (navegador caído) caduca y se puede volver a contestar', async () => {
  const { clinicId, call } = await sonando();
  await Call.updateOne(
    { _id: call._id },
    { $set: { acceptingBy: new H.mongoose.Types.ObjectId(), acceptingAt: new Date(Date.now() - 60000) } }
  );
  const r = await contestar(clinicId, new H.mongoose.Types.ObjectId(), call.callId);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
});

test('el «connect» de Meta sobre una ENTRANTE ya contestada no se trata como answer', async () => {
  const { clinicId, call } = await sonando();
  await contestar(clinicId, new H.mongoose.Types.ObjectId(), call.callId);
  emitidos = [];
  await callController.handleCallWebhook(clinicId, {
    calls: [{ id: call.callId, event: 'connect', direction: 'USER_INITIATED', session: { sdp_type: 'answer', sdp: 'v=0 eco' } }],
  }, cuenta);
  assert.equal(emitidos.filter((e) => e.evento === 'call:answered').length, 0);
  assert.equal((await Call.findById(call._id)).status, 'active');
});
