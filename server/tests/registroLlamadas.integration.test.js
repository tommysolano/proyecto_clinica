/**
 * REGISTRO DE LLAMADAS (Fénix, oct-2026).
 *
 * Lo que fijan estos tests:
 *   1. el resultado se deduce de si la llamada llegó a CONECTARSE, no del
 *      `status` guardado: una entrante «completed» sin conexión es PERDIDA, y
 *      una «active» cuya conexión es posterior al fin, también;
 *   2. duración y timbre salen de las marcas de tiempo;
 *   3. los filtros (resultado, dirección, búsqueda) y el resumen;
 *   4. un asesor no ve las llamadas de un chat reservado a otro;
 *   5. el webhook ya no guarda como completada una entrante que nadie contestó.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Call = require('../models/Call');
const Conversation = require('../models/Conversation');
const callLog = require('../controllers/callLogController');
const callController = require('../controllers/callController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const hace = (min) => new Date(Date.now() - min * 60 * 1000);
const seg = (fecha, s) => new Date(fecha.getTime() + s * 1000);

async function seed() {
  const clinicId = new H.mongoose.Types.ObjectId();
  const userId = new H.mongoose.Types.ObjectId();
  const ana = await Conversation.create({ clinic: clinicId, phone: '593999001122', channel: 'whatsapp', contactName: 'Ana Pérez' });
  const luis = await Conversation.create({ clinic: clinicId, phone: '593988776655', channel: 'whatsapp', contactName: 'Luis Mora' });
  const base = (conv, extra) => Call.create({ clinic: clinicId, conversation: conv._id, phone: conv.phone, ...extra });

  const t1 = hace(60);
  const contestada = await base(ana, {
    direction: 'in', status: 'completed', startedAt: t1, connectedAt: seg(t1, 12), endedAt: seg(t1, 102), durationSec: 90, agentName: 'Emily',
  });
  const t2 = hace(50);
  // Meta dijo COMPLETED pero nadie contestó: es una perdida.
  const perdidaMal = await base(ana, { direction: 'in', status: 'completed', startedAt: t2, endedAt: seg(t2, 40) });
  const t3 = hace(40);
  // El contacto colgó mientras el agente contestaba (conexión posterior al fin).
  const carrera = await base(luis, {
    direction: 'in', status: 'active', startedAt: t3, endedAt: seg(t3, 20), connectedAt: seg(t3, 21), agentName: 'Jaime',
  });
  const t4 = hace(30);
  const rechazada = await base(luis, { direction: 'in', status: 'rejected', startedAt: t4, endedAt: seg(t4, 5) });
  const t5 = hace(20);
  const saliente = await base(luis, {
    direction: 'out', status: 'completed', startedAt: t5, connectedAt: seg(t5, 8), endedAt: seg(t5, 68), durationSec: 60, agentName: 'Emily',
  });
  const t6 = hace(10);
  const noContesto = await base(ana, { direction: 'out', status: 'missed', startedAt: t6, endedAt: seg(t6, 60), agentName: 'Emily' });
  const sonando = await base(luis, { direction: 'in', status: 'ringing', startedAt: hace(0.5) });
  return { clinicId, userId, ana, luis, contestada, perdidaMal, carrera, rechazada, saliente, noContesto, sonando };
}

const pedir = (clinicId, userId, query = {}, role = 'admin') => H.runController(
  callLog.callLog,
  H.mockReq(clinicId, userId, {}, { role, query: { from: hoy(), to: hoy(), ...query } })
);

test('el resultado sale de la conexión, no del estado guardado', async () => {
  const s = await seed();
  const r = await pedir(s.clinicId, s.userId);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const de = (call) => r.payload.calls.find((c) => c.id === String(call._id));

  assert.equal(de(s.contestada).resultado, 'contestada');
  assert.equal(de(s.contestada).duracion, 90);
  assert.equal(de(s.contestada).timbre, 12, 'timbró hasta que se contestó');
  assert.equal(de(s.contestada).contacto, 'Ana Pérez');

  assert.equal(de(s.perdidaMal).resultado, 'perdida', '«completed» sin conexión no es una llamada contestada');
  assert.equal(de(s.perdidaMal).timbre, 40);
  assert.equal(de(s.carrera).resultado, 'perdida', 'conectar después del fin no es haber hablado');
  assert.equal(de(s.rechazada).resultado, 'rechazada');
  assert.equal(de(s.saliente).resultado, 'contestada');
  assert.equal(de(s.noContesto).resultado, 'no_contesto');
  assert.equal(de(s.sonando).resultado, 'en_curso');

  const res = r.payload.resumen;
  assert.equal(res.total, 7);
  assert.equal(res.entrantes, 5);
  assert.equal(res.salientes, 2);
  assert.equal(res.contestada, 2);
  assert.equal(res.perdida, 2);
  assert.equal(res.entrantesContestadas, 1);
  assert.equal(res.duracionTotal, 150);
  assert.equal(res.esperaPromedio, 12);
  // Las más recientes primero.
  assert.equal(r.payload.calls[0].id, String(s.sonando._id));
});

test('filtra por resultado, dirección y búsqueda sin cambiar el resumen de arriba', async () => {
  const s = await seed();
  const perdidas = await pedir(s.clinicId, s.userId, { result: 'perdida' });
  assert.deepEqual(perdidas.payload.calls.map((c) => c.resultado), ['perdida', 'perdida']);
  assert.equal(perdidas.payload.resumen.total, 7, 'las tarjetas siguen contando todas');

  const salientes = await pedir(s.clinicId, s.userId, { direction: 'out' });
  assert.equal(salientes.payload.calls.length, 2);

  const porNombre = await pedir(s.clinicId, s.userId, { q: 'luis' });
  assert.equal(porNombre.payload.calls.length, 4);
  const porTelefono = await pedir(s.clinicId, s.userId, { q: '0999001122' });
  assert.equal(porTelefono.payload.calls.length, 3);
});

test('un asesor no ve las llamadas de un chat reservado a otro asesor', async () => {
  const s = await seed();
  await Conversation.updateOne(
    { _id: s.luis._id },
    { workflowRestrictedTo: new H.mongoose.Types.ObjectId(), workflowRestrictionActive: true }
  );
  const agente = await pedir(s.clinicId, s.userId, {}, 'call_center');
  assert.equal(agente.statusCode, 200, JSON.stringify(agente.payload));
  assert.ok(agente.payload.calls.every((c) => c.conversationId === String(s.ana._id)));
  const admin = await pedir(s.clinicId, s.userId, {}, 'admin');
  assert.equal(admin.payload.calls.length, 7, 'administración ve todo');
});

test('el webhook guarda como PERDIDA la entrante que terminó sin contestarse', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const conv = await Conversation.create({ clinic: clinicId, phone: '593999112233', channel: 'whatsapp' });
  const call = await Call.create({
    clinic: clinicId, conversation: conv._id, callId: 'wacid.sin.contestar', direction: 'in', phone: conv.phone, status: 'ringing',
  });
  await callController.handleCallWebhook(clinicId, {
    calls: [{ id: 'wacid.sin.contestar', event: 'terminate', status: 'COMPLETED', direction: 'USER_INITIATED' }],
  });
  const fin = await Call.findById(call._id);
  assert.equal(fin.status, 'missed');
});
