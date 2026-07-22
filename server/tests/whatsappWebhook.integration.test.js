/**
 * Integración del webhook de WhatsApp Cloud API contra los controllers reales y
 * un Mongo en memoria: firma, ingesta de mensajes, botones interactivos,
 * deduplicación por reintento, atribución click-to-WhatsApp, calidad del número
 * y envío de eventos a la Conversions API (con fetch interceptado).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
const WhatsappAccount = require('../models/WhatsappAccount');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Notification = require('../models/Notification');
const capi = require('../utils/metaConversions');
const { clearCache } = require('../utils/callCenterClinic');

const APP_SECRET = 'test-app-secret';

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); clearCache(); });

/** Config global + número Cloud API listos para recibir webhooks. */
async function seedWhatsapp() {
  const clinicId = new H.mongoose.Types.ObjectId();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.cloudApi = { appSecret: APP_SECRET, verifyToken: 'tok' };
  cfg.callCenterClinic = clinicId;
  await cfg.save();
  const account = await WhatsappAccount.create({
    label: 'Principal',
    connectionType: 'cloud_api',
    phoneNumberId: '111222333',
    businessAccountId: 'waba1',
    accessToken: 'token-x',
    displayPhone: '+593 99 111 2233',
  });
  return { clinicId, account };
}

/** Simula el POST firmado de Meta al webhook único de WhatsApp. */
async function postWebhook(body) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
  const req = { body, rawBody, headers: { 'x-hub-signature-256': signature }, params: {}, query: {} };
  return H.runController(chat.webhookWhatsappReceive, req);
}

const messagePayload = (msg, { phoneNumberId = '111222333', contacts } = {}) => ({
  entry: [{
    changes: [{
      field: 'messages',
      value: {
        metadata: { phone_number_id: phoneNumberId },
        contacts: contacts || [{ profile: { name: 'Ana Cliente' } }],
        messages: [msg],
      },
    }],
  }],
});

test('rechaza el webhook con firma inválida', async () => {
  await seedWhatsapp();
  const body = messagePayload({ from: '593999000111', id: 'wamid.1', type: 'text', text: { body: 'hola' } });
  const req = {
    body,
    rawBody: Buffer.from(JSON.stringify(body)),
    headers: { 'x-hub-signature-256': 'sha256=firma-falsa' },
    params: {},
    query: {},
  };
  const r = await H.runController(chat.webhookWhatsappReceive, req);
  assert.equal(r.statusCode, 403);
  assert.equal(await Message.countDocuments(), 0);
});

test('ingesta texto entrante: conversación + mensaje + atribución click-to-WhatsApp', async () => {
  const { clinicId } = await seedWhatsapp();
  const r = await postWebhook(messagePayload({
    from: '593999000111',
    id: 'wamid.text1',
    type: 'text',
    text: { body: 'Vi su anuncio' },
    referral: { source_id: 'ad_777', headline: 'Promo julio', ctwa_clid: 'CLID-abc' },
  }));
  assert.equal(r.statusCode, 200);

  const conv = await Conversation.findOne({ clinic: clinicId, phone: '593999000111' });
  assert.ok(conv, 'debe crear la conversación');
  assert.equal(conv.attribution.adId, 'ad_777');
  assert.equal(conv.attribution.ctwaClid, 'CLID-abc');
  assert.equal(conv.contactName, 'Ana Cliente');

  const msg = await Message.findOne({ conversation: conv._id });
  assert.equal(msg.body, 'Vi su anuncio');
  assert.equal(msg.externalId, 'wamid.text1');
  assert.equal(msg.direction, 'in');
  // El anuncio de origen queda en el mensaje para pintarlo en el chat.
  assert.equal(msg.referral.sourceId, 'ad_777');
  assert.equal(msg.referral.headline, 'Promo julio');
  assert.equal(msg.referral.ctwaClid, 'CLID-abc');
});

test('reintento de Meta (mismo message id) NO duplica el mensaje', async () => {
  const { clinicId } = await seedWhatsapp();
  const payload = messagePayload({ from: '593999000111', id: 'wamid.dup', type: 'text', text: { body: 'hola' } });
  await postWebhook(payload);
  await postWebhook(payload); // reintento idéntico
  assert.equal(await Message.countDocuments({ clinic: clinicId, externalId: 'wamid.dup' }), 1);
  assert.equal(await Conversation.countDocuments({ clinic: clinicId }), 1);
});

test('captura id y título de botones interactivos y de listas', async () => {
  const { clinicId } = await seedWhatsapp();
  await postWebhook(messagePayload({
    from: '593999000111',
    id: 'wamid.btn1',
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: 'quiero_promo', title: 'Quiero la promo' } },
  }));
  await postWebhook(messagePayload({
    from: '593999000111',
    id: 'wamid.list1',
    type: 'interactive',
    interactive: { type: 'list_reply', list_reply: { id: 'svc_limpieza', title: 'Limpieza dental' } },
  }));
  // Botón de respuesta rápida de plantilla (formato m.button con payload).
  await postWebhook(messagePayload({
    from: '593999000111',
    id: 'wamid.tplbtn1',
    type: 'button',
    button: { payload: 'confirmar_cita', text: 'Confirmar' },
  }));

  const btn = await Message.findOne({ clinic: clinicId, externalId: 'wamid.btn1' });
  assert.equal(btn.interactiveReply.id, 'quiero_promo');
  assert.equal(btn.interactiveReply.type, 'button_reply');
  assert.equal(btn.body, 'Quiero la promo');

  const list = await Message.findOne({ clinic: clinicId, externalId: 'wamid.list1' });
  assert.equal(list.interactiveReply.id, 'svc_limpieza');
  assert.equal(list.interactiveReply.type, 'list_reply');
  assert.equal(list.body, 'Limpieza dental');

  const tplBtn = await Message.findOne({ clinic: clinicId, externalId: 'wamid.tplbtn1' });
  assert.equal(tplBtn.interactiveReply.id, 'confirmar_cita');
  assert.equal(tplBtn.body, 'Confirmar');
});

test('webhook de calidad: FLAGGED marca el número en ROJO y crea alerta', async () => {
  const { clinicId, account } = await seedWhatsapp();
  const body = {
    entry: [{
      changes: [{
        field: 'phone_number_quality_update',
        value: { display_phone_number: '+593991112233', event: 'FLAGGED', current_limit: 'TIER_250' },
      }],
    }],
  };
  const r = await postWebhook(body);
  assert.equal(r.statusCode, 200);

  const acc = await WhatsappAccount.findById(account._id);
  assert.equal(acc.qualityRating, 'RED');
  assert.equal(acc.messagingLimit, 'TIER_250');

  const alert = await Notification.findOne({ clinic: clinicId, type: 'whatsapp_quality_changed' });
  assert.ok(alert, 'debe crear la alerta de calidad');
  assert.equal(alert.severity, 'error');
});

test('CAPI: envía Lead con teléfono hasheado, action_source business_messaging y event_id', async () => {
  await seedWhatsapp();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.conversionsApi = { enabled: true, datasetId: 'DS123', accessToken: 'capi-token', testEventCode: '' };
  await cfg.save();

  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), body: JSON.parse(opts.body) });
    return { ok: true, json: async () => ({ events_received: 1 }) };
  };
  try {
    const r = await capi.sendConversionEvent({
      eventName: 'Lead',
      eventId: 'lead_conv1',
      user: { phone: '+593 999 000 111', ctwaClid: 'CLID-abc' },
      customData: { chat_funnel_stage: 'nueva_conversacion' },
    });
    assert.equal(r.ok, true);
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes('/DS123/events'), 'postea al dataset configurado');
  const ev = calls[0].body.data[0];
  assert.equal(ev.event_name, 'Lead');
  assert.equal(ev.event_id, 'lead_conv1');
  // Formato oficial de CTWA/business messaging (no 'chat'): así Meta atribuye la
  // conversión al anuncio click-to-WhatsApp.
  assert.equal(ev.action_source, 'business_messaging');
  assert.equal(ev.messaging_channel, 'whatsapp');
  const expectedPh = crypto.createHash('sha256').update('593999000111').digest('hex');
  assert.deepEqual(ev.user_data.ph, [expectedPh]);
  assert.equal(ev.user_data.ctwa_clid, 'CLID-abc');
});

test('CAPI deshabilitada: no llama a Meta y devuelve skipped', async () => {
  await seedWhatsapp(); // sin conversionsApi
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; return { ok: true, json: async () => ({}) }; };
  try {
    const r = await capi.sendConversionEvent({ eventName: 'Lead', eventId: 'x', user: { phone: '593999000111' } });
    assert.equal(r.skipped, true);
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(called, false);
});

test('el webhook con Lead configurado reporta a Meta al crear la conversación', async () => {
  await seedWhatsapp();
  const cfg = await CallCenterWhatsappConfig.getSingleton();
  cfg.conversionsApi = { enabled: true, datasetId: 'DS123', accessToken: 'capi-token', testEventCode: '' };
  await cfg.save();

  const capiCalls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/DS123/events')) capiCalls.push(JSON.parse(opts.body));
    return { ok: true, json: async () => ({}) };
  };
  try {
    await postWebhook(messagePayload({
      from: '593999000222',
      id: 'wamid.lead1',
      type: 'text',
      text: { body: 'hola' },
      referral: { source_id: 'ad_9', ctwa_clid: 'CLID-lead' },
    }));
    // reportLead es fire-and-forget: dale un tick para completar.
    await new Promise((resolve) => setTimeout(resolve, 100));
  } finally {
    global.fetch = originalFetch;
  }

  assert.equal(capiCalls.length, 1, 'debe enviar exactamente un Lead');
  const ev = capiCalls[0].data[0];
  assert.equal(ev.event_name, 'Lead');
  assert.equal(ev.user_data.ctwa_clid, 'CLID-lead');
  assert.ok(ev.event_id.startsWith('lead_'), 'event_id determinístico por conversación');
});
