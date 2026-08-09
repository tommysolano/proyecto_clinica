/**
 * "SI DESCONECTO UN NÚMERO Y LO VUELVO A CONECTAR, SE PIERDE SU IDENTIFICADOR".
 *
 * Todo el historial del CRM cuelga del `_id` de la WhatsappAccount: de qué número
 * entró cada chat, por cuál se abrió la ventana de 24h y por cuál salió cada
 * mensaje. Ese id es de un DOCUMENTO, no del teléfono: borrar el número y volverlo
 * a crear —el camino natural cuando "se cayó y hay que reconectarlo"— dejaba 4.585
 * chats apuntando a un id inexistente, respondiéndose por el número por defecto y
 * rechazados por Meta con 131047 (07/08-ago-2026).
 *
 * Estos tests fijan la regla nueva: la identidad de un número es SU TELÉFONO.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const WhatsappAccount = require('../models/WhatsappAccount');
const messaging = require('../utils/messaging');
const identity = require('../utils/whatsappIdentity');
const gateway = require('../utils/whatsappGateway');
const callCenterConfigController = require('../controllers/callCenterConfigController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const TEL_PACIENTE = '593989429136';
const TEL_QR = '593993519937';

async function numeros() {
  const api = await WhatsappAccount.create({
    label: 'API', connectionType: 'cloud_api', accessToken: 'T', phoneNumberId: '1',
    displayPhone: '+593939855651', phoneKey: '593939855651', enabled: true, isDefault: true,
  });
  const qr = await WhatsappAccount.create({
    label: 'Recepcion QR', connectionType: 'qr', connectedPhone: TEL_QR, phoneKey: TEL_QR,
    enabled: true, status: 'connected',
  });
  return { api, qr };
}

/** La paciente escribió al número `cuenta` hace 2 horas (ventana bien abierta). */
async function entrante(clinicId, cuenta) {
  const cuando = new Date(Date.now() - 2 * 3600 * 1000);
  const conv = await Conversation.create({
    clinic: clinicId, phone: TEL_PACIENTE, channel: 'whatsapp',
    whatsappAccount: cuenta._id,
    lastInboundAt: cuando,
    lastInboundAccount: cuenta._id,
    window24hExpiresAt: messaging.computeWhatsappWindowExpiresAt(cuando),
    lastMessageDirection: 'in',
    lastMessageAt: cuando,
  });
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in',
    body: 'Hola', whatsappAccount: cuenta._id, createdAt: cuando,
  });
  return conv;
}

// ─────────── 1. borrar ya no destruye nada ───────────

test('borrar un número lo ARCHIVA: desaparece de la lista pero su historial sigue enlazado', async () => {
  const { clinicId } = await H.seedClinic();
  const { qr } = await numeros();
  const conv = await entrante(clinicId, qr);

  await H.runController(
    callCenterConfigController.deleteWhatsappAccount,
    H.mockReq(clinicId, null, {}, { params: { id: String(qr._id) } })
  );

  const lapida = await WhatsappAccount.findById(qr._id);
  assert.ok(lapida, 'el documento no se borra de verdad');
  assert.ok(lapida.archivedAt, 'queda archivado');
  assert.equal(lapida.enabled, false);

  const { payload } = await H.runController(
    callCenterConfigController.listWhatsappAccounts,
    H.mockReq(clinicId, null)
  );
  assert.deepEqual(payload.map((a) => a.label), ['API'], 'la lista solo muestra los números en uso');

  const chat = await Conversation.findById(conv._id).lean();
  assert.equal(String(chat.lastInboundAccount), String(qr._id), 'el chat recuerda por dónde entró');
});

// ─────────── 2. reconectar el MISMO teléfono recupera todo ───────────

test('reconectar el mismo teléfono como número NUEVO recupera sus chats y su ventana de 24h', async () => {
  const { clinicId } = await H.seedClinic();
  const { qr } = await numeros();
  const conv = await entrante(clinicId, qr);

  // Se borra el número (el usuario no sabe todavía por dónde va a reconectarlo).
  await H.runController(
    callCenterConfigController.deleteWhatsappAccount,
    H.mockReq(clinicId, null, {}, { params: { id: String(qr._id) } })
  );

  // Y se vuelve a crear desde cero: documento nuevo, id nuevo.
  const { payload: nuevo } = await H.runController(
    callCenterConfigController.createWhatsappAccount,
    H.mockReq(clinicId, null, { label: 'Recepcion QR 2', connectionType: 'qr' })
  );
  assert.notEqual(String(nuevo._id), String(qr._id));

  // Escanea el QR y WhatsApp confirma que es el MISMO teléfono de siempre.
  const r = await identity.rememberLinkedPhone(nuevo._id, TEL_QR);
  assert.equal(r.adopted, 1, 'reconoce que ya existía ese número');
  assert.equal(r.conversations, 1);
  assert.equal(r.messages, 1);

  const curada = await Conversation.findById(conv._id).lean();
  assert.equal(String(curada.whatsappAccount), String(nuevo._id), 'el chat vuelve a su número');
  assert.equal(String(curada.lastInboundAccount), String(nuevo._id), 'y con él la ventana de 24h');

  const vivo = await WhatsappAccount.findById(nuevo._id);
  assert.deepEqual(vivo.previousIds.map(String), [String(qr._id)], 'se queda con la identidad anterior');
  assert.equal(await WhatsappAccount.findById(qr._id), null, 'la lápida ya no hace falta');

  // Y la ventana sigue ABIERTA por ese número (escribió hace 2 h).
  assert.equal(messaging.isWhatsappWindowOpen(curada, new Date(), vivo), true);
});

// ─────────── 3. el id viejo sigue reconociéndose mientras tanto ───────────

test('un chat que recuerda el id VIEJO se resuelve al número reconectado, no al por defecto', async () => {
  const { clinicId } = await H.seedClinic();
  const { api, qr } = await numeros();
  const conv = await entrante(clinicId, qr);

  // Número reconectado que ya absorbió al anterior, pero un chat quedó con el
  // enlace viejo (remapeo a medias, respaldo restaurado, importación antigua…).
  const reconectado = await WhatsappAccount.create({
    label: 'Recepcion QR 2', connectionType: 'qr', connectedPhone: TEL_QR, phoneKey: TEL_QR,
    enabled: true, status: 'connected', previousIds: [qr._id],
  });
  await WhatsappAccount.deleteOne({ _id: qr._id });

  const cuenta = await gateway.resolveAccountForConversation(await Conversation.findById(conv._id));
  assert.equal(String(cuenta._id), String(reconectado._id), 'sale por SU número');
  assert.notEqual(String(cuenta._id), String(api._id), 'y no por el número por defecto');

  // La ventana también lo reconoce como el mismo número.
  const win = messaging.describeWhatsappWindow(
    (await Conversation.findById(conv._id)).toObject(), 'cloud_api', new Date(), reconectado
  );
  assert.equal(win.otherNumber, false, 'no es "otro número": es el mismo teléfono');
  assert.equal(win.open, true);
});

// ─────────── 4. escanear otro teléfono queda registrado ───────────

test('escanear OTRO teléfono en la misma conexión no borra el rastro del anterior', async () => {
  await H.seedClinic();
  const { qr } = await numeros();

  await identity.rememberLinkedPhone(qr._id, '593987000111');

  const doc = await WhatsappAccount.findById(qr._id);
  assert.equal(doc.phoneKey, '593987000111', 'la identidad pasa a ser el teléfono nuevo');
  assert.deepEqual(doc.previousPhoneKeys, [TEL_QR], 'pero el anterior queda anotado');
});

// ─────────── 5. el mismo teléfono en otro formato es el mismo teléfono ───────────

test('el teléfono se reconoce en cualquier formato (0988… y 593988…)', () => {
  assert.equal(identity.samePhone('0988535561', '593988535561'), true);
  assert.equal(identity.samePhone('+593 98 853 5561', '593988535561'), true);
  assert.equal(identity.samePhone('593988535561', '593993519937'), false);
  assert.equal(identity.samePhone('', '593988535561'), false);
});

// ─────────── 6. desconectar y reconectar sin borrar nada no cambia NADA ───────────

test('desconectar y reconectar el mismo número conserva su identificador', async () => {
  const { clinicId } = await H.seedClinic();
  const { qr } = await numeros();
  const conv = await entrante(clinicId, qr);

  // Reconexión: WhatsApp vuelve a confirmar el mismo teléfono.
  await identity.rememberLinkedPhone(qr._id, TEL_QR);

  const doc = await WhatsappAccount.findById(qr._id);
  assert.equal(String(doc._id), String(qr._id), 'mismo documento, mismo id');
  assert.deepEqual(doc.previousIds.map(String), [], 'no hay nada que adoptar');
  const chat = await Conversation.findById(conv._id).lean();
  assert.equal(String(chat.whatsappAccount), String(qr._id));
  assert.equal(messaging.isWhatsappWindowOpen(chat, new Date(), doc), true);
});
