const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const H = require('./_integrationHelpers');
const CallCenterConfig = require('../models/CallCenterConfig');
const Conversation = require('../models/Conversation');
const configController = require('../controllers/callCenterConfigController');
const chatController = require('../controllers/chatController');
const { encryptSecret } = require('../utils/secretCrypto');
const { fetchMessengerProfileName } = require('../utils/messengerProfile');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('Instagram test rejects a Page token when the linked Instagram account differs', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await CallCenterConfig.create({
    clinic: clinicId,
    instagram: {
      pageId: '123', igBusinessAccountId: 'expected-ig',
      pageAccessToken: encryptSecret('page-token'),
    },
  });
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    assert.match(url, /fields=name,instagram_business_account/);
    return { ok: true, json: async () => ({ name: 'Page', instagram_business_account: { id: 'different-ig' } }) };
  };
  try {
    const result = await H.runController(configController.testConnection, {
      clinicId, params: { channel: 'instagram' },
    });
    assert.equal(result.statusCode, 400);
    assert.match(result.payload.message, /Instagram/);
  } finally {
    global.fetch = originalFetch;
  }
});

test('Messenger webhook rejects unsigned events and ignores a signed echo', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await CallCenterConfig.create({
    clinic: clinicId,
    messenger: { enabled: true, pageId: 'page-1', appSecret: encryptSecret('app-secret'), verifyToken: 'verify' },
  });
  const body = {
    object: 'page',
    entry: [{ id: 'page-1', messaging: [{ sender: { id: 'page-1' }, recipient: { id: 'customer' }, message: { mid: 'echo-1', is_echo: true, text: 'hello' } }] }],
  };
  const unsigned = await H.runController(chatController.webhookMessengerReceive, {
    params: { clinicId }, body, headers: {},
  });
  assert.equal(unsigned.statusCode, 403);
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', 'app-secret').update(rawBody).digest('hex')}`;
  const signed = await H.runController(chatController.webhookMessengerReceive, {
    params: { clinicId }, body, rawBody, headers: { 'x-hub-signature-256': signature },
  });
  assert.equal(signed.statusCode, 200);
  assert.equal(await Conversation.countDocuments({ clinic: clinicId }), 0);

  await CallCenterConfig.updateOne({ clinic: clinicId }, { $set: { 'messenger.appSecret': '' } });
  const missingSecret = await H.runController(chatController.webhookMessengerReceive, {
    params: { clinicId }, body, rawBody, headers: { 'x-hub-signature-256': signature },
  });
  assert.equal(missingSecret.statusCode, 403);
  assert.equal(missingSecret.payload.code, 'app_secret_not_configured');
});

test('Messenger profile uses the Page token without exposing a PSID as the contact name', async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.match(url, /\/12345\?fields=first_name,last_name$/);
    assert.equal(options.headers.Authorization, 'Bearer page-token');
    return { ok: true, json: async () => ({ first_name: 'María', last_name: 'Pérez' }) };
  };
  try {
    assert.equal(await fetchMessengerProfileName({
      senderId: '12345', encryptedPageAccessToken: encryptSecret('page-token'),
    }), 'María Pérez');
  } finally {
    global.fetch = originalFetch;
  }
});

test('A signed Messenger message saves the profile name and the Messenger channel', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await CallCenterConfig.create({
    clinic: clinicId,
    messenger: {
      enabled: true, pageId: 'page-1', appSecret: encryptSecret('app-secret'),
      pageAccessToken: encryptSecret('page-token'), verifyToken: 'verify',
    },
  });
  const body = {
    object: 'page', entry: [{ id: 'page-1', messaging: [{
      sender: { id: '12345' }, recipient: { id: 'page-1' },
      message: { mid: 'incoming-1', text: 'Hola' },
    }] }],
  };
  const rawBody = Buffer.from(JSON.stringify(body));
  const signature = `sha256=${crypto.createHmac('sha256', 'app-secret').update(rawBody).digest('hex')}`;
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ first_name: 'María', last_name: 'Pérez' }) });
  try {
    const result = await H.runController(chatController.webhookMessengerReceive, {
      params: { clinicId }, body, rawBody, headers: { 'x-hub-signature-256': signature },
    });
    assert.equal(result.statusCode, 200);
    const saved = await Conversation.findOne({ clinic: clinicId, externalUserId: '12345' });
    assert.equal(saved.channel, 'messenger');
    assert.equal(saved.contactName, 'María Pérez');
  } finally {
    global.fetch = originalFetch;
  }
});

test('Opening an old Messenger chat fills its profile name and preserves manual names', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await CallCenterConfig.create({
    clinic: clinicId,
    messenger: { pageAccessToken: encryptSecret('page-token') },
  });
  const old = await Conversation.create({
    clinic: clinicId, channel: 'messenger', phone: '12345', externalUserId: '12345',
  });
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async () => {
    calls++;
    return { ok: true, json: async () => ({ first_name: 'María', last_name: 'Pérez' }) };
  };
  try {
    const result = await H.runController(chatController.getConversation, {
      clinicId, role: 'admin', user: { _id: new H.mongoose.Types.ObjectId() }, params: { id: old._id },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.payload.contactName, 'María Pérez');
    assert.equal((await Conversation.findById(old._id)).contactName, 'María Pérez');
    assert.equal(calls, 1);

    await Conversation.updateOne({ _id: old._id }, {
      $set: { contactName: 'Nombre corregido', contactNameEditedAt: new Date(), contactNameSource: 'manual' },
    });
    const manual = await H.runController(chatController.getConversation, {
      clinicId, role: 'admin', user: { _id: new H.mongoose.Types.ObjectId() }, params: { id: old._id },
    });
    assert.equal(manual.payload.contactName, 'Nombre corregido');
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});
