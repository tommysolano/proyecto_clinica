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
    return { ok: true, data: { messages: [{ id: 'true_204496395366461@lid_SENT123' }] } };
  };

  try {
    const req = H.mockReq(clinicId, userId, { body: 'segundo test de respuesta', replyTo: String(incoming._id) }, { params: { id: String(conv._id) } });
    req.user.name = 'Super Administrador Shiluv';
    const out = await H.runController(chat.sendMessage, req);
    assert.equal(out.statusCode, 201, JSON.stringify(out.payload));
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
    return { ok: true, data: { messages: [{ id: 'x' }] } };
  };
  try {
    const req = H.mockReq(clinicId, userId, { body: 'hola', replyTo: String(noWamid._id) }, { params: { id: String(conv._id) } });
    req.user.name = 'Agente';
    await H.runController(chat.sendMessage, req);
  } finally {
    qrManager.sendText = orig;
  }
  assert.equal(calls.length, 1);
  assert.ok(!calls[0].quotedMessageId, 'sin wamid no hay quotedMessageId');
  assert.equal(calls[0].quoteBody, 'test de conexion', 'se pasa el texto para citar en vivo por contenido');
});
