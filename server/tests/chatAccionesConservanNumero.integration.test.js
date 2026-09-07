/**
 * «HAGO CUALQUIER COSA EN EL CHAT Y ME DICE QUE NO SABE POR QUÉ NÚMERO ESCRIBIR».
 *
 * Reclamo real (7-sep-2026): al destacar un chat, crear una oportunidad,
 * etiquetarlo o asignarlo, la pantalla saltaba con el aviso rojo «este chat no
 * tiene ningún número por el que responder» y el cuadro de escribir se quedaba
 * inhabilitado. Había que recargar para poder seguir la conversación.
 *
 * La causa no era el número: era la RESPUESTA. El navegador reemplaza el chat
 * abierto con lo que devuelve la mutación, y esas mutaciones devolvían el
 * documento a pelo — sin los campos DERIVADOS que calcula el servidor al salir
 * (`window`, `sendingAccount`, `inboundAccount`, `effectiveConnectionType`).
 * Sin ellos, la pantalla no sabía ni por qué número había entrado el contacto ni
 * si la ventana de 24h seguía abierta, y se ponía en lo peor.
 *
 * Lo que fijan estos tests: TODA acción sobre un chat devuelve la conversación
 * con sus derivados (ver `respondConversation` en chatController).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const WhatsappAccount = require('../models/WhatsappAccount');
const Patient = require('../models/Patient');
const chat = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const TEL = '593987654321';

async function seed() {
  const clinicId = new H.mongoose.Types.ObjectId();
  const userId = new H.mongoose.Types.ObjectId();
  const cuenta = await WhatsappAccount.create({
    label: 'Recepcion', connectionType: 'cloud_api', accessToken: 'T', phoneNumberId: '1',
    displayPhone: '+593939855651', enabled: true, isDefault: true,
  });
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: TEL,
    contactName: 'Ana',
    lastInboundAccount: cuenta._id,
    lastInboundAt: new Date(),
    lastMessageAt: new Date(),
  });
  return { clinicId, userId, cuenta, conv };
}

const req = (clinicId, userId, body = {}, id) =>
  H.mockReq(clinicId, userId, body, { role: 'call_center', params: { id: String(id) } });

/** Lo que la pantalla necesita para saber si puede escribir. */
function assertTraeDerivados(payload, cuenta, etiqueta) {
  assert.ok(payload, `${etiqueta}: sin respuesta`);
  assert.ok(payload.window, `${etiqueta}: falta el estado de la ventana de 24h`);
  assert.equal(
    String(payload.sendingAccount?._id || ''), String(cuenta._id),
    `${etiqueta}: no dice por qué número sale la respuesta`
  );
  assert.equal(
    String(payload.inboundAccount?._id || ''), String(cuenta._id),
    `${etiqueta}: no dice a qué número escribió el contacto`
  );
  assert.equal(payload.effectiveConnectionType, 'cloud_api', `${etiqueta}: tipo de conexión`);
}

test('destacar el chat no lo deja sin número por el que responder', async () => {
  const { clinicId, userId, cuenta, conv } = await seed();
  const r = await H.runController(chat.toggleFeatured, req(clinicId, userId, { isFeatured: true }, conv._id));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  assert.equal(r.payload.isFeatured, true);
  assertTraeDerivados(r.payload, cuenta, 'destacar');
});

test('crear una oportunidad tampoco', async () => {
  const { clinicId, userId, cuenta, conv } = await seed();
  const r = await H.runController(
    chat.addOpportunity,
    req(clinicId, userId, { name: 'Botox', stage: 'nuevo' }, conv._id)
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assertTraeDerivados(r.payload, cuenta, 'oportunidad');
});

test('etiquetar, asignar y bloquear devuelven lo mismo', async () => {
  const { clinicId, userId, cuenta, conv } = await seed();

  const etiquetado = await H.runController(
    chat.updateConversation, req(clinicId, userId, { tags: ['promo'] }, conv._id)
  );
  assert.equal(etiquetado.statusCode < 400, true, JSON.stringify(etiquetado.payload));
  assertTraeDerivados(etiquetado.payload, cuenta, 'etiquetar');

  const asignado = await H.runController(
    chat.assignConversation, req(clinicId, userId, {}, conv._id)
  );
  assert.equal(asignado.statusCode < 400, true, JSON.stringify(asignado.payload));
  assertTraeDerivados(asignado.payload, cuenta, 'asignar');

  const bloqueado = await H.runController(
    chat.toggleBlocked, req(clinicId, userId, { blocked: true }, conv._id)
  );
  assert.equal(bloqueado.statusCode < 400, true, JSON.stringify(bloqueado.payload));
  assertTraeDerivados(bloqueado.payload, cuenta, 'bloquear');
});

test('registrar al paciente desde el chat devuelve la conversación completa', async () => {
  const { clinicId, userId, cuenta, conv } = await seed();
  const r = await H.runController(
    chat.registerPatientFromChat,
    req(clinicId, userId, { firstName: 'Ana', lastName: 'Pérez Chávez', email: 'ana@x.com' }, conv._id)
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assertTraeDerivados(r.payload.conversation, cuenta, 'registrar paciente');
  // Y el alta es la de siempre: paciente creado y chat vinculado.
  const paciente = await Patient.findOne({ phone: TEL });
  assert.ok(paciente, 'se creó el paciente');
  // El modelo guarda los nombres en mayúsculas (así los devuelve el SRI).
  assert.equal(paciente.lastName, 'PÉREZ CHÁVEZ');
  assert.equal(String((await Conversation.findById(conv._id)).patient), String(paciente._id));
});
