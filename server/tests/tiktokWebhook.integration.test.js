/**
 * Recepción de mensajes directos de TikTok (Business Messaging API).
 *
 *  - Solo entran avisos firmados con el App Secret (TikTok-Signature).
 *  - Del aviso se toma el conversation_id y los mensajes se leen de
 *    /business/message/content/list/ (formato documentado); el chat queda
 *    ligado a ESA conversación (externalUserId), que es a donde se responde.
 *  - TikTok reintenta el aviso: el mismo message_id no se duplica.
 *
 * Se mockea `fetch` global — no se llama a TikTok de verdad.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const CallCenterConfig = require('../models/CallCenterConfig');
const { encryptSecret } = require('../utils/secretCrypto');
const tiktok = require('../utils/tiktokMessaging');
const chatCtrl = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const SECRET = 'TT_APP_SECRET';
const CONV_ID = 'AbC+12/xyz==';

async function seedTiktok(clinicId) {
  await CallCenterConfig.create({
    clinic: clinicId,
    tiktok: {
      enabled: true,
      appId: 'APP1',
      appSecret: encryptSecret(SECRET),
      accessToken: encryptSecret('TT_TOKEN'),
      accessTokenExpiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      businessId: 'BIZ_OPEN_ID',
    },
  });
}

function installFetchMock(responder) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return responder(String(url), opts);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

const apiOk = (data) => ({ ok: true, status: 200, json: async () => ({ code: 0, message: 'OK', data }) });

function contentList(messages) {
  return {
    participants: [
      { role: 'PERSONAL_ACCOUNT', id: 'U1', display_name: 'Ana Pérez' },
      { role: 'BUSINESS_ACCOUNT', id: 'BIZ_OPEN_ID', display_name: 'Clínica' },
    ],
    messages,
  };
}

const aviso = (messageId) => ({
  client_key: 'APP1',
  event: 'direct_message',
  create_time: Math.floor(Date.now() / 1000),
  user_openid: 'BIZ_OPEN_ID',
  content: JSON.stringify({ conversation_id: CONV_ID, message_id: messageId }),
});

test('aviso de mensaje: entra a la bandeja con el nombre del contacto y ligado a la conversación de TikTok', async () => {
  const { clinicId } = await H.seedClinic();
  await seedTiktok(clinicId);
  const now = Date.now();
  const mock = installFetchMock(async (url) => {
    assert.match(url, /\/business\/message\/content\/list\//);
    assert.match(url, /conversation_id=AbC%2B12%2Fxyz%3D%3D/, 'el + del conversation_id debe ir codificado');
    return apiOk(contentList([
      { message_id: 'OLD', conversation_id: CONV_ID, sender: 'U1', message_type: 'TEXT', text: { body: 'viejo' }, timestamp: now - 86400000 },
      { message_id: 'M1', conversation_id: CONV_ID, sender: 'U1', message_type: 'TEXT', text: { body: 'Hola, ¿precio del suero?' }, timestamp: now },
      { message_id: 'B1', conversation_id: CONV_ID, sender: 'BIZ_OPEN_ID', message_type: 'TEXT', text: { body: 'respuesta nuestra' }, timestamp: now },
    ]));
  });
  try {
    const r = await tiktok.processWebhook(clinicId, aviso('M1'), chatCtrl.ingestExternalMessage);
    assert.equal(r.ingested, 1);
    // Reintento de TikTok: no se duplica.
    await tiktok.processWebhook(clinicId, aviso('M1'), chatCtrl.ingestExternalMessage);
  } finally {
    mock.restore();
  }
  const conv = await Conversation.findOne({ clinic: clinicId, channel: 'tiktok' }).lean();
  assert.ok(conv, 'no se creó el chat');
  assert.equal(conv.externalUserId, CONV_ID);
  assert.equal(conv.contactName, 'Ana Pérez');
  const msgs = await Message.find({ conversation: conv._id }).lean();
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].body, 'Hola, ¿precio del suero?');
  assert.equal(msgs[0].externalId, 'M1');
});

test('dos conversaciones de TikTok con los mismos dígitos no se mezclan en un chat', async () => {
  const { clinicId } = await H.seedClinic();
  await seedTiktok(clinicId);
  for (const [conv, mid] of [['a1b2', 'X1'], ['c1d2', 'X2']]) {
    const mock = installFetchMock(async () => apiOk(contentList([
      { message_id: mid, conversation_id: conv, sender: 'U1', message_type: 'TEXT', text: { body: 'hola' }, timestamp: Date.now() },
    ])));
    try {
      await tiktok.processWebhook(clinicId, { content: JSON.stringify({ conversation_id: conv, message_id: mid }) }, chatCtrl.ingestExternalMessage);
    } finally {
      mock.restore();
    }
  }
  assert.equal(await Conversation.countDocuments({ clinic: clinicId, channel: 'tiktok' }), 2);
});

test('webhook: sin firma válida se rechaza (401) y queda el motivo en la configuración', async () => {
  const { clinicId } = await H.seedClinic();
  await seedTiktok(clinicId);
  const body = aviso('M1');
  const raw = JSON.stringify(body);
  const req = H.mockReq(clinicId, null, body, { params: { clinicId: String(clinicId) }, headers: { 'tiktok-signature': 't=1,s=deadbeef' } });
  req.rawBody = Buffer.from(raw);
  const state = await H.runController(chatCtrl.webhookTiktokReceive, req);
  assert.equal(state.statusCode, 401);
  await new Promise((r) => setTimeout(r, 200)); // el motivo se guarda sin bloquear la respuesta
  const cfg = await CallCenterConfig.findOne({ clinic: clinicId }).lean();
  assert.match(cfg.tiktok.lastEventError, /rechazado/);
});

test('webhook: con firma válida responde 200 enseguida', async () => {
  const { clinicId } = await H.seedClinic();
  await seedTiktok(clinicId);
  const body = aviso('M9');
  const raw = JSON.stringify(body);
  const t = Math.floor(Date.now() / 1000);
  const s = crypto.createHmac('sha256', SECRET).update(`${t}.${raw}`).digest('hex');
  const mock = installFetchMock(async () => apiOk(contentList([])));
  try {
    const req = H.mockReq(clinicId, null, body, { params: { clinicId: String(clinicId) }, headers: { 'tiktok-signature': `t=${t},s=${s}` } });
    req.rawBody = Buffer.from(raw);
    const state = await H.runController(chatCtrl.webhookTiktokReceive, req);
    assert.equal(state.statusCode, 200);
    // Deja terminar el procesamiento en segundo plano antes de soltar el mock.
    await new Promise((r) => setTimeout(r, 300));
  } finally {
    mock.restore();
  }
});
