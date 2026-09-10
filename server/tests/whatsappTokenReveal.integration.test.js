const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const User = require('../models/User');
const WhatsappAccount = require('../models/WhatsappAccount');
const CallCenterWhatsappConfig = require('../models/CallCenterWhatsappConfig');
const AuditLog = require('../models/AuditLog');
const configController = require('../controllers/callCenterConfigController');
const { encryptSecret } = require('../utils/secretCrypto');

const ORIGINAL_SECRETS_KEY = process.env.SECRETS_KEY;
const TEST_SECRETS_KEY = '6a00e39ec60269ce703cb0bc89495f2ce2f4dc00e731f9f151757ab2266e3cd8';

test.before(async () => {
  process.env.SECRETS_KEY = TEST_SECRETS_KEY;
  await H.startDb();
});

test.after(async () => {
  await H.stopDb();
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.SECRETS_KEY;
  else process.env.SECRETS_KEY = ORIGINAL_SECRETS_KEY;
});

test.beforeEach(async () => { await H.resetDb(); });

async function seedAdmin() {
  const clinicId = new mongoose.Types.ObjectId();
  const password = 'Clave-segura-2026';
  const user = await User.create({
    name: 'Administrador',
    email: `admin-token-${Date.now()}@example.com`,
    password: await bcrypt.hash(password, 4),
    clinics: [{ clinic: clinicId, role: 'admin' }],
  });
  return { clinicId, password, user };
}

async function seedCloudAccount(userId, token = 'EAAB-token-secreto-123456') {
  return WhatsappAccount.create({
    label: 'Recepcion Meta',
    connectionType: 'cloud_api',
    displayPhone: '+593999999999',
    phoneNumberId: '1234567890',
    businessAccountId: '9988776655',
    accessToken: encryptSecret(token),
    createdBy: userId,
  });
}

function revealReq(clinicId, userId, accountId, currentPassword, role = 'admin') {
  const req = H.mockReq(
    clinicId,
    userId,
    { currentPassword },
    { role, params: { id: String(accountId) } }
  );
  req.originalUrl = `/api/call-center-config/whatsapp/accounts/${accountId}/reveal-token`;
  req.ip = '127.0.0.1';
  return req;
}

function capiRevealReq(clinicId, userId, currentPassword, role = 'admin') {
  const req = H.mockReq(clinicId, userId, { currentPassword }, { role });
  req.originalUrl = '/api/call-center-config/whatsapp/capi/reveal-token';
  req.ip = '127.0.0.1';
  return req;
}

test('el listado mantiene el token enmascarado y el endpoint protegido permite copiar el valor real', async () => {
  const { clinicId, password, user } = await seedAdmin();
  const plainToken = 'EAAB-token-secreto-123456';
  const account = await seedCloudAccount(user._id, plainToken);

  const stored = await WhatsappAccount.findById(account._id).lean();
  assert.notEqual(stored.accessToken, plainToken, 'el token debe permanecer cifrado en la base');

  const listed = await H.runController(
    configController.listWhatsappAccounts,
    H.mockReq(clinicId, user._id)
  );
  assert.equal(listed.statusCode, 200);
  assert.notEqual(listed.payload[0].accessToken, plainToken);
  assert.match(listed.payload[0].accessToken, /^•+/);

  const revealed = await H.runController(
    configController.revealWhatsappAccountToken,
    revealReq(clinicId, user._id, account._id, password)
  );
  assert.equal(revealed.statusCode, 200, JSON.stringify(revealed.payload));
  assert.equal(revealed.payload.accessToken, plainToken);
  assert.equal(revealed.headers['Cache-Control'], 'no-store, private');
  assert.equal(revealed.headers.Pragma, 'no-cache');

  const audit = await AuditLog.findOne({ action: 'REVEAL_SECRET', entityId: String(account._id) }).lean();
  assert.equal(audit.success, true);
  assert.equal(JSON.stringify(audit).includes(plainToken), false, 'la auditoria no debe copiar el token');
  assert.equal(JSON.stringify(audit).includes(password), false, 'la auditoria no debe copiar la contrasena');
});

test('una contrasena incorrecta no revela el token y deja el intento fallido en auditoria', async () => {
  const { clinicId, user } = await seedAdmin();
  const account = await seedCloudAccount(user._id);

  const result = await H.runController(
    configController.revealWhatsappAccountToken,
    revealReq(clinicId, user._id, account._id, 'incorrecta')
  );

  assert.equal(result.statusCode, 403);
  assert.equal(Object.hasOwn(result.payload, 'accessToken'), false);
  const audit = await AuditLog.findOne({ action: 'REVEAL_SECRET', entityId: String(account._id) }).lean();
  assert.equal(audit.success, false);
  assert.match(audit.errorMessage, /incorrecta/i);
});

test('marketing no puede revelar tokens aunque conozca la contrasena', async () => {
  const { clinicId, password, user } = await seedAdmin();
  const account = await seedCloudAccount(user._id);

  const result = await H.runController(
    configController.revealWhatsappAccountToken,
    revealReq(clinicId, user._id, account._id, password, 'marketing')
  );

  assert.equal(result.statusCode, 403);
  assert.equal(Object.hasOwn(result.payload, 'accessToken'), false);
});

test('el token CAPI sigue enmascarado en la configuracion y un admin puede recuperarlo', async () => {
  const { clinicId, password, user } = await seedAdmin();
  const plainToken = 'EAAB-capi-token-secreto-987654';
  const config = await CallCenterWhatsappConfig.create({
    singleton: 'main',
    conversionsApi: {
      enabled: true,
      datasetId: '1420022846345736',
      accessToken: encryptSecret(plainToken),
      whatsappBusinessAccountId: '2126912681204794',
    },
  });

  const stored = await CallCenterWhatsappConfig.findById(config._id).lean();
  assert.notEqual(stored.conversionsApi.accessToken, plainToken, 'el token CAPI debe permanecer cifrado');

  const normalConfig = await H.runController(
    configController.getWhatsappAppConfig,
    H.mockReq(clinicId, user._id)
  );
  assert.equal(normalConfig.statusCode, 200);
  assert.notEqual(normalConfig.payload.conversionsApi.accessToken, plainToken);
  assert.match(normalConfig.payload.conversionsApi.accessToken, /^•+/);

  const revealed = await H.runController(
    configController.revealConversionsApiToken,
    capiRevealReq(clinicId, user._id, password)
  );
  assert.equal(revealed.statusCode, 200, JSON.stringify(revealed.payload));
  assert.equal(revealed.payload.accessToken, plainToken);
  assert.equal(revealed.headers['Cache-Control'], 'no-store, private');
  assert.equal(revealed.headers.Pragma, 'no-cache');

  const audit = await AuditLog.findOne({
    action: 'REVEAL_SECRET',
    entity: 'CallCenterWhatsappConfig',
    entityId: String(config._id),
  }).lean();
  assert.equal(audit.success, true);
  assert.equal(JSON.stringify(audit).includes(plainToken), false, 'la auditoria no debe copiar el token CAPI');
  assert.equal(JSON.stringify(audit).includes(password), false, 'la auditoria no debe copiar la contrasena');
});

test('el token CAPI no se revela con contrasena incorrecta ni al rol marketing', async () => {
  const { clinicId, password, user } = await seedAdmin();
  await CallCenterWhatsappConfig.create({
    singleton: 'main',
    conversionsApi: { accessToken: encryptSecret('EAAB-capi-privado') },
  });

  const wrongPassword = await H.runController(
    configController.revealConversionsApiToken,
    capiRevealReq(clinicId, user._id, 'incorrecta')
  );
  assert.equal(wrongPassword.statusCode, 403);
  assert.equal(Object.hasOwn(wrongPassword.payload, 'accessToken'), false);

  const marketing = await H.runController(
    configController.revealConversionsApiToken,
    capiRevealReq(clinicId, user._id, password, 'marketing')
  );
  assert.equal(marketing.statusCode, 403);
  assert.equal(Object.hasOwn(marketing.payload, 'accessToken'), false);
});
