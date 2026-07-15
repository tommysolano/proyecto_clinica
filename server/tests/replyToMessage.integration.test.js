/**
 * Responder a un mensaje específico (cita estilo WhatsApp) + indicador de
 * remitente. Verifica que sendMessage persista el snapshot replyTo, que valide
 * que el citado sea de la MISMA conversación, y que el mensaje guarde sentByName.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const WhatsappAccount = require('../models/WhatsappAccount');

async function seedConvWithIncoming(clinicId) {
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: '593987654321',
    contactName: 'Génesis Prueba',
    channel: 'whatsapp',
    lastMessageAt: new Date(),
    lastMessageDirection: 'in',
    // Ventana de 24h abierta para permitir texto libre.
    window24hExpiresAt: new Date(Date.now() + 20 * 60 * 60 * 1000),
  });
  const incoming = await Message.create({
    clinic: clinicId,
    conversation: conv._id,
    direction: 'in',
    body: '¿Cuánto cuesta el suero VIP?',
    externalId: 'wamid.INCOMING123',
    deliveryStatus: 'delivered',
  });
  return { conv, incoming };
}

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('sendMessage con replyTo guarda el snapshot del mensaje citado y el remitente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Un número QR "conectado" no existe en el harness, pero sin cuenta el envío
  // se marca skipped ANTES de crear el mensaje. Creamos una cuenta stub cloud:
  // el proveedor fallará, pero el mensaje se persiste con replyTo igual.
  await WhatsappAccount.create({ label: 'Stub', connectionType: 'cloud_api', accessToken: '', enabled: true, isDefault: true });
  const { conv, incoming } = await seedConvWithIncoming(clinicId);

  const req = H.mockReq(clinicId, userId, { body: 'Cuesta $80, agenda cuando gustes', replyTo: String(incoming._id) }, { params: { id: String(conv._id) } });
  req.user.name = 'Dra. Ana';
  const out = await H.runController(chat.sendMessage, req);
  assert.equal(out.statusCode, 201, JSON.stringify(out.payload));

  const saved = await Message.findById(out.payload._id);
  assert.ok(saved.replyTo, 'persiste replyTo');
  assert.equal(String(saved.replyTo.message), String(incoming._id));
  assert.equal(saved.replyTo.direction, 'in');
  assert.equal(saved.replyTo.senderName, 'Génesis Prueba', 'remitente citado = contacto');
  assert.match(saved.replyTo.body, /suero VIP/);
  assert.equal(saved.replyTo.externalId, 'wamid.INCOMING123', 'guarda el wamid para citar en WhatsApp');
  // Indicador de remitente del mensaje enviado.
  assert.equal(saved.sentByName, 'Dra. Ana');
  assert.equal(String(saved.sentBy), String(userId));
});

// ─────────────────────────────────────────────────────────────────────────────
test('replyTo de otra conversación se ignora (no se cita un mensaje ajeno)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await WhatsappAccount.create({ label: 'Stub', connectionType: 'cloud_api', accessToken: '', enabled: true, isDefault: true });
  const { conv } = await seedConvWithIncoming(clinicId);
  // Mensaje de OTRA conversación.
  const otherConv = await Conversation.create({ clinic: clinicId, phone: '593900000000', channel: 'whatsapp', lastMessageAt: new Date() });
  const foreignMsg = await Message.create({ clinic: clinicId, conversation: otherConv._id, direction: 'in', body: 'ajeno', deliveryStatus: 'delivered' });

  const req = H.mockReq(clinicId, userId, { body: 'hola', replyTo: String(foreignMsg._id) }, { params: { id: String(conv._id) } });
  req.user.name = 'Agente';
  const out = await H.runController(chat.sendMessage, req);
  assert.equal(out.statusCode, 201, JSON.stringify(out.payload));
  const saved = await Message.findById(out.payload._id);
  assert.ok(!saved.replyTo?.message, 'no se cita un mensaje de otra conversación');
});
