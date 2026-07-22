/**
 * Multi-número: responder SIEMPRE desde el número al que el contacto escribió,
 * teniendo varios números conectados a la vez (QR + Cloud API).
 *
 *  - La conversación enlazada a un número responde por ESE número (no por el default).
 *  - Si la conversación NO tiene número enlazado (chat viejo), se responde por el
 *    número por el que ENTRÓ su último mensaje entrante (auto-cura), no por el default.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const messaging = require('../utils/messaging');
const gateway = require('../utils/whatsappGateway');
const WhatsappAccount = require('../models/WhatsappAccount');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// QR marcado por DEFECTO + un Cloud API secundario: si algo falla, el sistema caería
// en el QR (default). Los tests comprueban que NO cae ahí cuando corresponde otro.
async function seedTwoNumbers() {
  const qr = await WhatsappAccount.create({ label: 'QR', connectionType: 'qr', enabled: true, isDefault: true, status: 'connected' });
  const cloud = await WhatsappAccount.create({
    label: 'Cloud', connectionType: 'cloud_api', enabled: true, isDefault: false,
    phoneNumberId: '111', accessToken: 'tok', businessAccountId: 'waba',
  });
  return { qr, cloud };
}

function interceptSend() {
  const calls = [];
  const orig = gateway.sendText;
  gateway.sendText = async (account, to, body) => {
    calls.push({ accountId: String(account?._id), to, body });
    return { ok: true, data: { messages: [{ id: 'wamid.X' }] } };
  };
  return { calls, restore: () => { gateway.sendText = orig; } };
}

test('la conversación enlazada a un número responde por ESE número, no por el default', async () => {
  const { clinicId } = await H.seedClinic();
  const { cloud } = await seedTwoNumbers();
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593999111222', channel: 'whatsapp',
    whatsappAccount: cloud._id, // el contacto escribió al número Cloud
    window24hExpiresAt: new Date(Date.now() + 20 * 3600 * 1000),
    lastInboundAt: new Date(),
  });

  const { calls, restore } = interceptSend();
  try {
    const r = await messaging.send({ clinicId, channel: 'whatsapp', conversation: conv, to: conv.phone, body: 'hola' });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { restore(); }

  assert.equal(calls.length, 1, 'se envió una vez');
  assert.equal(calls[0].accountId, String(cloud._id), 'salió por el número Cloud (al que escribieron), no por el QR default');
});

test('conversación SIN número enlazado: responde por el número del ÚLTIMO entrante (auto-cura), no por el default', async () => {
  const { clinicId } = await H.seedClinic();
  const { cloud } = await seedTwoNumbers();
  // Chat viejo, sin whatsappAccount enlazado.
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593999111222', channel: 'whatsapp',
    whatsappAccount: null,
    window24hExpiresAt: new Date(Date.now() + 20 * 3600 * 1000),
    lastInboundAt: new Date(),
  });
  // Pero su último mensaje entrante SÍ recuerda por qué número entró (Cloud).
  await Message.create({ clinic: clinicId, conversation: conv._id, direction: 'in', body: 'hola', whatsappAccount: cloud._id, deliveryStatus: 'delivered' });

  const { calls, restore } = interceptSend();
  try {
    const r = await messaging.send({ clinicId, channel: 'whatsapp', conversation: conv, to: conv.phone, body: 'respuesta' });
    assert.equal(r.ok, true, JSON.stringify(r));
  } finally { restore(); }

  assert.equal(calls[0].accountId, String(cloud._id), 'se respondió por el número del último entrante, no por el QR default');
  // Auto-cura: la conversación queda enlazada a ese número para la próxima vez.
  const fresh = await Conversation.findById(conv._id).lean();
  assert.equal(String(fresh.whatsappAccount), String(cloud._id), 'la conversación quedó enlazada al número correcto');
});

test('sin enlace y sin entrantes con número: cae en el número por defecto (último recurso)', async () => {
  const { clinicId } = await H.seedClinic();
  const { qr } = await seedTwoNumbers();
  // QR es el default; sin datos para inferir otro, se usa el default.
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593999111222', channel: 'whatsapp', whatsappAccount: null,
    lastInboundAt: new Date(),
  });

  const { calls, restore } = interceptSend();
  try {
    await messaging.send({ clinicId, channel: 'whatsapp', conversation: conv, to: conv.phone, body: 'hola' });
  } finally { restore(); }
  assert.equal(calls[0].accountId, String(qr._id), 'sin pistas, el número por defecto (QR)');
});
