/**
 * "EL SISTEMA DICE QUE ME QUEDAN 8 HORAS Y EL MENSAJE NO SALE".
 *
 * Caso real (8-ago-2026, chat 593989429136 y otros 155 mensajes esa mañana). La
 * paciente había escrito "Muchas gracias" a las 17:59 del día anterior. A la
 * mañana siguiente el chat mostraba en verde "Ventana de 24h ABIERTA: puedes
 * escribir libremente durante 8 h 12 min más", la agente escribió, y Meta lo
 * rechazó con 131047: "más de 24 horas desde que el cliente respondió A ESTE
 * NÚMERO".
 *
 * Las dos cosas eran ciertas a la vez. La ventana de 24 h de WhatsApp es de la
 * pareja (NÚMERO DE LA CLÍNICA, contacto): la paciente había escrito al número
 * QR de recepción, pero el mensaje salía por el número de la Cloud API, al que
 * jamás le había escrito. ¿Por qué salía por ahí? Porque la noche anterior se
 * borró el número QR y se reconectó como uno NUEVO: los 4.585 chats que colgaban
 * del viejo se quedaron apuntando a un id inexistente y la resolución del número
 * caía hasta el último recurso, el número por defecto.
 *
 * Estos tests fijan las dos reglas que faltaban:
 *   1. la ventana se mide contra el número por el que SALE el mensaje;
 *   2. borrar un número no puede dejar sus conversaciones colgando.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const MessageTemplate = require('../models/MessageTemplate');
const WhatsappAccount = require('../models/WhatsappAccount');
const messaging = require('../utils/messaging');
const chatController = require('../controllers/chatController');
const callCenterConfigController = require('../controllers/callCenterConfigController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const TEL = '593989429136';

/** Los dos números de la clínica: el de la API es el principal, el QR es el de recepción. */
async function numeros() {
  const api = await WhatsappAccount.create({
    label: 'Recepcion', connectionType: 'cloud_api', accessToken: 'T',
    phoneNumberId: '1', displayPhone: '+593939855651', enabled: true, isDefault: true,
  });
  const qr = await WhatsappAccount.create({
    label: 'Recepcion QR', connectionType: 'qr', connectedPhone: '593993519937',
    enabled: true, status: 'connected',
  });
  return { api, qr };
}

/** Anota qué llegó de verdad al proveedor: lo que no aparece aquí, no salió. */
function fakeGateway() {
  const gw = require('../utils/whatsappGateway');
  const sent = [];
  const orig = { sendText: gw.sendText, sendTemplate: gw.sendTemplate };
  gw.sendText = async (account, to, body) => {
    sent.push({ tipo: 'texto', cuenta: account.label, to, body });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  gw.sendTemplate = async (account, to, templateName) => {
    sent.push({ tipo: 'plantilla', cuenta: account.label, to, templateName });
    return { ok: true, data: { messages: [{ id: `wamid.${sent.length}` }] } };
  };
  return { sent, restore: () => Object.assign(gw, orig) };
}

/** La paciente escribe al número `cuenta`, hace `haceHoras` horas. */
async function entrante(clinicId, cuenta, haceHoras = 15) {
  const cuando = new Date(Date.now() - haceHoras * 3600 * 1000);
  const conv = await Conversation.create({
    clinic: clinicId, phone: TEL, channel: 'whatsapp',
    whatsappAccount: cuenta._id,
    lastInboundAt: cuando,
    lastInboundAccount: cuenta._id,
    window24hExpiresAt: messaging.computeWhatsappWindowExpiresAt(cuando),
    lastMessageDirection: 'in',
    lastMessageAt: cuando,
  });
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in',
    body: 'Muchas gracias', whatsappAccount: cuenta._id, createdAt: cuando,
  });
  return conv;
}

// ─────────── 1. la ventana pertenece al número al que escribieron ───────────

test('escribir al QR no abre ventana en el número de la Cloud API', async () => {
  const { clinicId } = await H.seedClinic();
  const { api, qr } = await numeros();
  const conv = await entrante(clinicId, qr);

  // Por el número al que la paciente escribió: se puede escribir (además es QR,
  // que ni siquiera tiene ventana).
  const porQr = messaging.describeWhatsappWindow(conv.toObject(), 'qr', new Date(), qr._id);
  assert.equal(porQr.open, true);

  // Por el otro número: no hay ventana ninguna, aunque escribiera hace 15 h.
  const porApi = messaging.describeWhatsappWindow(conv.toObject(), 'cloud_api', new Date(), api._id);
  assert.equal(porApi.open, false, 'Meta no reconoce aquí ninguna ventana');
  assert.equal(porApi.otherNumber, true, 'y se explica: escribió a otro número');
  assert.ok(porApi.lastInboundAt, 'el "escribió hace 15 h" sigue siendo verdad');
});

// ─────────── 2. el chat huérfano ya no manda por el número equivocado ───────────

test('borrado el número QR, el texto libre NO se cuela por el número por defecto', async () => {
  const { clinicId } = await H.seedClinic();
  const { qr } = await numeros();
  const conv = await entrante(clinicId, qr);
  const gw = fakeGateway();

  try {
    // La noche anterior se borra el número QR (sin decir quién hereda los chats).
    await H.runController(
      callCenterConfigController.deleteWhatsappAccount,
      H.mockReq(clinicId, null, {}, { params: { id: String(qr._id) } })
    );

    // A la mañana siguiente la agente escribe a mano.
    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: await Conversation.findById(conv._id), to: TEL,
      body: 'Buen dia disculpe no ha llegado a su cita, tal vez ya se encuentra cerca?',
    });

    assert.equal(r.ok, false);
    assert.equal(r.reason, 'out_of_window', 'se para aquí en vez de gastarlo y perderlo en Meta');
    assert.deepEqual(gw.sent, [], 'no salió nada por el número de la API');
  } finally {
    gw.restore();
  }
});

// ─────────── 3. y la UI deja de prometer una ventana que no existe ───────────

test('el chat del caso real ya no enseña "ventana abierta" cuando el envío va a fallar', async () => {
  const { clinicId } = await H.seedClinic();
  const { qr } = await numeros();
  await entrante(clinicId, qr);
  await H.runController(
    callCenterConfigController.deleteWhatsappAccount,
    H.mockReq(clinicId, null, {}, { params: { id: String(qr._id) } })
  );

  const { payload } = await H.runController(chatController.listConversations, H.mockReq(clinicId, null));
  const chat = payload.items.find((c) => c.phone === TEL);
  assert.ok(chat, 'el chat sigue en la bandeja');
  assert.equal(chat.window.applies, true, 'cae al número Cloud, así que la ventana aplica');
  assert.equal(chat.window.open, false, 'y está cerrada: es lo que va a decir Meta');
  assert.equal(chat.sendingAccount.label, 'Recepcion', 'la UI puede decir por qué número saldría');
});

// ─────────── 4. borrar un número traspasando sus chats ───────────

test('al borrar un número se pueden traspasar sus chats al teléfono reconectado', async () => {
  const { clinicId } = await H.seedClinic();
  const { qr } = await numeros();
  const conv = await entrante(clinicId, qr);
  // El mismo teléfono, reconectado: queda guardado como un número NUEVO.
  const qrNuevo = await WhatsappAccount.create({
    label: 'Recepcion 2', connectionType: 'qr', connectedPhone: '593993519937',
    enabled: true, status: 'connected',
  });
  const gw = fakeGateway();

  try {
    const { payload } = await H.runController(
      callCenterConfigController.deleteWhatsappAccount,
      H.mockReq(clinicId, null, { replacementId: String(qrNuevo._id) }, { params: { id: String(qr._id) } })
    );
    assert.equal(payload.conversations, 1);
    assert.equal(payload.messages, 1, 'el historial también se traspasa');

    const movida = await Conversation.findById(conv._id);
    assert.equal(String(movida.whatsappAccount), String(qrNuevo._id));
    assert.equal(String(movida.lastInboundAccount), String(qrNuevo._id), 'y con él la ventana');

    const r = await messaging.send({ clinicId, channel: 'whatsapp', conversation: movida, to: TEL, body: 'Buen día' });
    assert.equal(r.ok, true);
    assert.equal(gw.sent[0].cuenta, 'Recepcion 2', 'sale por el teléfono que la paciente conoce');
  } finally {
    gw.restore();
  }
});

// ─────────── 5. reparar los chats que YA quedaron huérfanos ───────────

test('la reparación del diagnóstico traspasa los chats colgados a un número vivo', async () => {
  const { clinicId } = await H.seedClinic();
  const { qr } = await numeros();
  const conv = await entrante(clinicId, qr);
  await WhatsappAccount.deleteOne({ _id: qr._id }); // el borrado de antes, a pelo
  const qrNuevo = await WhatsappAccount.create({
    label: 'Recepcion 2', connectionType: 'qr', connectedPhone: '593993519937', enabled: true,
  });

  const { payload } = await H.runController(
    callCenterConfigController.healWhatsappLinks,
    H.mockReq(clinicId, null, { accountId: String(qrNuevo._id) })
  );
  assert.equal(payload.healed, 1);
  assert.equal(payload.windows, 1);
  assert.equal(payload.messages, 1);
  assert.equal(payload.movedTo, 'Recepcion 2');

  const curada = await Conversation.findById(conv._id).lean();
  assert.equal(String(curada.whatsappAccount), String(qrNuevo._id));
  assert.equal(String(curada.lastInboundAccount), String(qrNuevo._id));
});

// ─────────── 6. la plantilla sigue siendo la salida ───────────

test('fuera de ventana la plantilla aprobada sí sale (es lo que ofrece el chat)', async () => {
  const { clinicId } = await H.seedClinic();
  const { api, qr } = await numeros();
  const conv = await entrante(clinicId, qr);
  await MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: 'recordatorio', status: 'approved',
    body: 'Te esperamos en tu cita.',
  });
  const gw = fakeGateway();

  try {
    const r = await messaging.send({
      clinicId, channel: 'whatsapp', conversation: await Conversation.findById(conv._id), to: TEL,
      whatsappAccount: api._id, // forzado al número sin ventana
      template: { name: 'recordatorio', language: 'es' },
    });
    assert.equal(r.ok, true, 'la plantilla funciona fuera de la ventana, para eso está');
    assert.equal(gw.sent[0].tipo, 'plantilla');
  } finally {
    gw.restore();
  }
});
