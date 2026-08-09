/**
 * Verifica que el `quotedMessageId` (wamid del mensaje citado) llega REALMENTE
 * hasta el gateway QR cuando se responde a un mensaje. Intercepta
 * whatsappQrManager.sendText para capturar el 4º argumento.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const WhatsappAccount = require('../models/WhatsappAccount');
const qrManager = require('../utils/whatsappQrManager');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('responder a un mensaje con wamid pasa quotedMessageId al gateway QR', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await WhatsappAccount.create({ label: 'QR Test', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });

  const conv = await Conversation.create({
    clinic: clinicId, phone: '204496395366461', externalUserId: '204496395366461@lid',
    contactName: '.', channel: 'whatsapp', lastMessageAt: new Date(), lastMessageDirection: 'in',
    window24hExpiresAt: new Date(Date.now() + 20 * 3600 * 1000),
  });
  // Mensaje entrante REAL (con wamid serializado tipo whatsapp-web.js).
  const incoming = await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in',
    body: 'test de conexion', externalId: 'false_204496395366461@lid_3EB0ABCDEF', deliveryStatus: 'delivered',
  });

  // Interceptar el envío por QR.
  const calls = [];
  const orig = qrManager.sendText;
  qrManager.sendText = async (account, to, body, quotedMessageId, quoteBody) => {
    calls.push({ to, body, quotedMessageId, quoteBody });
    return {
      ok: true,
      data: { messages: [{ id: 'true_204496395366461@lid_SENT123' }] },
      quote: { applied: true, how: 'id', reason: '', wamid: quotedMessageId },
    };
  };

  try {
    const req = H.mockReq(clinicId, userId, { body: 'segundo test de respuesta', replyTo: String(incoming._id) }, { params: { id: String(conv._id) } });
    req.user.name = 'Super Administrador Shiluv';
    const out = await H.runController(chat.sendMessage, req);
    assert.equal(out.statusCode, 201, JSON.stringify(out.payload));
    // La entrega va en segundo plano: se espera a que termine antes de devolver
    // el stub, o el gateway real se llevaría la llamada a medias.
    await H.waitForStatus(out.payload._id, 'sent');
  } finally {
    qrManager.sendText = orig;
  }

  assert.equal(calls.length, 1, 'se llamó a sendText del QR una vez');
  assert.equal(calls[0].quotedMessageId, 'false_204496395366461@lid_3EB0ABCDEF',
    'el wamid del mensaje citado llega como quotedMessageId al gateway QR');
  assert.equal(calls[0].quoteBody, 'test de conexion',
    'el texto del mensaje citado llega como quoteBody (respaldo para citar por texto)');
  // Y se responde al JID completo (@lid), no a los dígitos.
  assert.equal(calls[0].to, '204496395366461@lid');
  // El resultado real de la cita queda auditado en el mensaje saliente.
  const outMsg = await Message.findOne({ conversation: conv._id, direction: 'out' }).lean();
  assert.equal(outMsg.quoteResult, 'quoted_by_id');
});

test('responder a un mensaje SIN wamid pasa el texto como quoteBody (respaldo por texto)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await WhatsappAccount.create({ label: 'QR Test', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
  const conv = await Conversation.create({
    clinic: clinicId, phone: '204496395366461', externalUserId: '204496395366461@lid',
    contactName: '.', channel: 'whatsapp', lastMessageAt: new Date(), lastMessageDirection: 'in',
    window24hExpiresAt: new Date(Date.now() + 20 * 3600 * 1000),
  });
  // Mensaje SIN externalId (p.ej. LID donde no se expuso el wamid, o simulado).
  const noWamid = await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in', body: 'test de conexion', deliveryStatus: 'delivered',
  });

  const calls = [];
  const orig = qrManager.sendText;
  qrManager.sendText = async (account, to, body, quotedMessageId, quoteBody) => {
    calls.push({ quotedMessageId, quoteBody });
    // Simula que la sesión LOCALIZÓ el mensaje por texto y lo citó: devuelve el
    // wamid descubierto para que se respalde en el mensaje original.
    return {
      ok: true,
      data: { messages: [{ id: 'x' }] },
      quote: { applied: true, how: 'text', reason: '', wamid: 'false_204496395366461@lid_FOUND99' },
    };
  };
  try {
    const req = H.mockReq(clinicId, userId, { body: 'hola', replyTo: String(noWamid._id) }, { params: { id: String(conv._id) } });
    req.user.name = 'Agente';
    const out = await H.runController(chat.sendMessage, req);
    await H.waitForStatus(out.payload._id, 'sent'); // la entrega va en segundo plano
  } finally {
    qrManager.sendText = orig;
  }
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].quotedMessageId, 'sin wamid no hay quotedMessageId');
  assert.equal(calls[0].quoteBody, 'test de conexion', 'se pasa el texto para citar en vivo por contenido');
  // Auditoría + respaldo: el saliente registra que citó por texto y el mensaje
  // original recibe el wamid descubierto (las próximas citas irán por id).
  const outMsg = await Message.findOne({ conversation: conv._id, direction: 'out' }).lean();
  assert.equal(outMsg.quoteResult, 'quoted_by_text');
  const original = await Message.findById(noWamid._id).lean();
  assert.equal(original.externalId, 'false_204496395366461@lid_FOUND99',
    'el wamid descubierto al citar por texto se respalda en el mensaje original');
});

test('si WhatsApp descartó la cita, el mensaje queda marcado failed:<motivo>', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await WhatsappAccount.create({ label: 'QR Test', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
  const conv = await Conversation.create({
    clinic: clinicId, phone: '204496395366461', externalUserId: '204496395366461@lid',
    contactName: '.', channel: 'whatsapp', lastMessageAt: new Date(), lastMessageDirection: 'in',
    window24hExpiresAt: new Date(Date.now() + 20 * 3600 * 1000),
  });
  const incoming = await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in', body: 'test de conexion', deliveryStatus: 'delivered',
  });

  const orig = qrManager.sendText;
  qrManager.sendText = async () => ({
    ok: true,
    data: { messages: [{ id: 'y' }] },
    quote: { applied: false, how: 'text', reason: 'library_dropped:cannot_reply', wamid: '' },
  });
  try {
    const req = H.mockReq(clinicId, userId, { body: 'hola', replyTo: String(incoming._id) }, { params: { id: String(conv._id) } });
    req.user.name = 'Agente';
    const sent = await H.runController(chat.sendMessage, req);
    // La entrega es en segundo plano: no restaures el stub ni leas quoteResult
    // hasta que el gateway haya terminado de guardar el resultado de la cita.
    await H.waitForStatus(sent.payload._id, 'sent');
  } finally {
    qrManager.sendText = orig;
  }
  const outMsg = await Message.findOne({ conversation: conv._id, direction: 'out' }).lean();
  assert.equal(outMsg.quoteResult, 'failed:library_dropped:cannot_reply',
    'el motivo real del descarte queda registrado para verlo en el CRM');
});

test('ack con el wamid bajo OTRA forma de JID actualiza el estado (fallback por hash)', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, phone: '204496395366461', externalUserId: '204496395366461@lid',
    channel: 'whatsapp', lastMessageAt: new Date(), lastMessageDirection: 'out',
  });
  const out = await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out', body: 'hola',
    externalId: 'true_204496395366461@lid_ABCDEF123456', deliveryStatus: 'sent',
  });
  const messaging = require('../utils/messaging');
  // El ack llega con el número REAL (@c.us) pero el MISMO hash.
  const r = await messaging.updateMessageStatus({
    clinicId, externalId: 'true_593999999999@c.us_ABCDEF123456', status: 'read',
  });
  assert.equal(r.ok, true, 'el ack encuentra el mensaje por el hash del wamid');
  const updated = await Message.findById(out._id).lean();
  assert.equal(updated.deliveryStatus, 'read');
});

test('cita entrante con hash pelado (quotedStanzaID) resuelve el mensaje citado', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, phone: '204496395366461', externalUserId: '204496395366461@lid',
    channel: 'whatsapp', lastMessageAt: new Date(), lastMessageDirection: 'out',
  });
  await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'out', body: 'hola, ¿confirmas tu cita?',
    externalId: 'true_204496395366461@lid_FEEDBEEF9999', deliveryStatus: 'sent', sentByName: 'Agente',
  });
  await chat.ingestExternalMessage({
    clinicId, channel: 'whatsapp', externalUserId: '204496395366461@lid', phone: '204496395366461',
    body: 'sí confirmo', externalId: 'false_204496395366461@lid_NEW1', contextId: 'FEEDBEEF9999',
  });
  const inMsg = await Message.findOne({ conversation: conv._id, direction: 'in' }).lean();
  assert.ok(inMsg, 'el mensaje entrante se ingirió');
  assert.equal(inMsg.replyTo?.externalId, 'true_204496395366461@lid_FEEDBEEF9999',
    'la cita entrante se resolvió por el hash aunque el contexto llegó pelado');
});
