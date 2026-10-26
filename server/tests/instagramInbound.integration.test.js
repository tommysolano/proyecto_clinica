/**
 * Instagram entrante (oct-2026): el chat tiene que decir QUIÉN escribe y DESDE
 * DÓNDE (historia, mención, publicación, anuncio), como ya pasaba en WhatsApp con
 * "📣 Mensaje desde anuncio". Antes solo se guardaba el texto: el chat se llamaba
 * «Contacto de Instagram» y una mención en una historia ni siquiera llegaba.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const CallCenterConfig = require('../models/CallCenterConfig');
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const { encryptSecret } = require('../utils/secretCrypto');
const { parseInstagramEvent } = require('../utils/instagramInbound');

const APP_SECRET = 'ig-app-secret';
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedInstagram() {
  const { clinicId } = await H.seedClinic();
  await CallCenterConfig.create({
    clinic: clinicId,
    instagram: {
      enabled: true,
      pageId: 'PAGE1',
      igBusinessAccountId: 'IGBIZ',
      pageAccessToken: encryptSecret('PAGE_TOKEN'),
      verifyToken: 'v',
      appSecret: encryptSecret(APP_SECRET),
    },
  });
  return clinicId;
}

// Graph API (perfil) + CDN de Meta (miniaturas) simulados.
function mockMeta({ profile = { name: 'Ana Pérez', username: 'ana.perez' } } = {}) {
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('graph.facebook.com')) {
      return { ok: true, status: 200, json: async () => profile };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: (h) => (h.toLowerCase() === 'content-type' ? 'image/png' : String(PNG.length)) },
      arrayBuffer: async () => PNG,
    };
  };
  return { calls, restore: () => { global.fetch = orig; } };
}

async function postWebhook(clinicId, messaging) {
  const body = { object: 'instagram', entry: [{ id: 'IGBIZ', messaging }] };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', APP_SECRET).update(rawBody).digest('hex')}`;
  const req = { body, rawBody, headers: { 'x-hub-signature-256': signature }, params: { clinicId: String(clinicId) }, query: {} };
  return H.runController(chat.webhookInstagramReceive, req);
}

const ev = (message, extra = {}) => ({ sender: { id: 'IGSID1' }, recipient: { id: 'IGBIZ' }, timestamp: Date.now(), message, ...extra });

test('el chat se llama como la persona y guarda su @usuario', async () => {
  const clinicId = await seedInstagram();
  const meta = mockMeta();
  try {
    const r = await postWebhook(clinicId, [ev({ mid: 'm1', text: 'Hola, info por favor' })]);
    assert.equal(r.statusCode ?? 200, 200, JSON.stringify(r.payload));
  } finally { meta.restore(); }
  const conv = await Conversation.findOne({ clinic: clinicId, channel: 'instagram' });
  assert.equal(conv.contactName, 'Ana Pérez');
  assert.equal(conv.externalUsername, 'ana.perez');
  assert.ok(meta.calls.some((u) => u.includes('IGSID1') && u.includes('username')));
});

test('sin nombre en el perfil, el chat se llama @usuario', async () => {
  const clinicId = await seedInstagram();
  const meta = mockMeta({ profile: { username: 'solo_usuario' } });
  try {
    await postWebhook(clinicId, [ev({ mid: 'm1', text: 'hola' })]);
  } finally { meta.restore(); }
  const conv = await Conversation.findOne({ clinic: clinicId, channel: 'instagram' });
  assert.equal(conv.contactName, '@solo_usuario');
});

test('respuesta a una historia: guarda el contexto y la miniatura', async () => {
  const clinicId = await seedInstagram();
  const meta = mockMeta();
  try {
    await postWebhook(clinicId, [ev({
      mid: 'm2',
      text: '¿Cuánto cuesta?',
      reply_to: { story: { id: 'STORY9', url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=9' } },
    })]);
  } finally { meta.restore(); }
  const msg = await Message.findOne({ externalId: 'm2' });
  assert.equal(msg.body, '¿Cuánto cuesta?');
  assert.equal(msg.referral.sourceType, 'ig_story_reply');
  assert.equal(msg.referral.sourceId, 'STORY9');
  assert.match(msg.referral.mediaUrl, /\/api\/public\/media\//);
  assert.equal(msg.referral.mediaType, 'image');
  const conv = await Conversation.findById(msg.conversation);
  assert.ok(!conv.attribution?.adId, 'una historia no es un anuncio');
});

test('mención en una historia (sin texto) ya no se pierde', async () => {
  const clinicId = await seedInstagram();
  const meta = mockMeta();
  try {
    await postWebhook(clinicId, [ev({
      mid: 'm3',
      attachments: [{ type: 'story_mention', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=3' } }],
    })]);
  } finally { meta.restore(); }
  const msg = await Message.findOne({ externalId: 'm3' });
  assert.ok(msg, 'el mensaje se guarda');
  assert.equal(msg.referral.sourceType, 'ig_story_mention');
  assert.match(msg.body, /mencionó en su historia/);
});

test('mensaje desde un anuncio de Instagram: atribución como en WhatsApp', async () => {
  const clinicId = await seedInstagram();
  const meta = mockMeta();
  try {
    await postWebhook(clinicId, [ev({
      mid: 'm4',
      text: 'Quiero agendar',
      referral: {
        ref: '', ad_id: 'AD777', source: 'ADS', type: 'OPEN_THREAD',
        ads_context_data: { ad_title: 'Sueroterapia 2x1', photo_url: 'https://scontent.cdninstagram.com/ad.png' },
      },
    })]);
  } finally { meta.restore(); }
  const msg = await Message.findOne({ externalId: 'm4' });
  assert.equal(msg.referral.sourceType, 'ig_ad');
  assert.equal(msg.referral.sourceId, 'AD777');
  assert.equal(msg.referral.headline, 'Sueroterapia 2x1');
  const conv = await Conversation.findById(msg.conversation);
  assert.equal(conv.attribution.adId, 'AD777');
  assert.equal(conv.attribution.campaign, 'Sueroterapia 2x1');
});

test('anuncio tocado ANTES de escribir se pega al primer mensaje', async () => {
  const clinicId = await seedInstagram();
  const meta = mockMeta();
  try {
    await postWebhook(clinicId, [{
      sender: { id: 'IGSID1' }, recipient: { id: 'IGBIZ' }, timestamp: Date.now(),
      referral: { ad_id: 'AD555', source: 'ADS', type: 'OPEN_THREAD', ads_context_data: { ad_title: 'Promo' } },
    }]);
    await postWebhook(clinicId, [ev({ mid: 'm5', text: 'hola' })]);
  } finally { meta.restore(); }
  const conv = await Conversation.findOne({ clinic: clinicId, channel: 'instagram' });
  assert.equal(conv.attribution.adId, 'AD555');
});

test('foto enviada por Instagram se guarda en nuestro almacén', async () => {
  const clinicId = await seedInstagram();
  const meta = mockMeta();
  try {
    await postWebhook(clinicId, [ev({
      mid: 'm6',
      attachments: [
        { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=6' } },
        { type: 'image', payload: { url: 'https://lookaside.fbsbx.com/ig_messaging_cdn/?asset_id=7' } },
      ],
    })]);
  } finally { meta.restore(); }
  const msgs = await Message.find({ externalId: { $in: ['m6', 'm6_1'] } }).sort({ externalId: 1 });
  assert.equal(msgs.length, 2, 'una burbuja por foto');
  for (const m of msgs) {
    assert.equal(m.mediaType, 'image');
    assert.match(m.mediaUrl, /\/api\/public\/media\//);
  }
});

test('publicación compartida: tipo y pie de foto', () => {
  const parts = parseInstagramEvent(ev({
    mid: 'x',
    attachments: [{ type: 'ig_post', payload: { ig_post_media_id: 'P1', title: 'Nuestro nuevo tratamiento', url: 'https://cdn/x.jpg' } }],
  }));
  assert.equal(parts.length, 1);
  assert.equal(parts[0].referral.sourceType, 'ig_post');
  assert.equal(parts[0].referral.headline, 'Nuestro nuevo tratamiento');
  assert.match(parts[0].body, /Compartió una publicación/);
});
