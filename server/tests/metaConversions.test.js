const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const capi = require('../utils/metaConversions');

test('hashes user data in SHA-256 normalized (trim + lowercase) as Meta requires', () => {
  const expected = crypto.createHash('sha256').update('correo@ejemplo.com').digest('hex');
  assert.equal(capi.hashSha256('  Correo@Ejemplo.COM  '), expected);
  assert.equal(capi.hashSha256(''), null);
  assert.equal(capi.hashSha256(null), null);
});

test('normalizes phones to digits-only with country code', () => {
  assert.equal(capi.normalizePhoneForCapi('+593 98-765-4321'), '593987654321');
  assert.equal(capi.normalizePhoneForCapi('593987654321'), '593987654321');
  assert.equal(capi.normalizePhoneForCapi(''), null);
});

test('builds user_data with hashed identifiers and raw ctwa_clid', () => {
  const ud = capi.buildUserData({
    phone: '+593 987 654 321',
    email: 'Paciente@Mail.com',
    firstName: 'Ana',
    lastName: 'Pérez',
    ctwaClid: 'ABC123xyz',
  });
  // El teléfono se hashea ya normalizado (solo dígitos).
  assert.deepEqual(ud.ph, [crypto.createHash('sha256').update('593987654321').digest('hex')]);
  assert.deepEqual(ud.em, [crypto.createHash('sha256').update('paciente@mail.com').digest('hex')]);
  assert.deepEqual(ud.fn, [crypto.createHash('sha256').update('ana').digest('hex')]);
  // ctwa_clid va SIN hashear (regla de Meta para click-to-WhatsApp).
  assert.equal(ud.ctwa_clid, 'ABC123xyz');
});

test('omits empty identifiers from user_data', () => {
  const ud = capi.buildUserData({ phone: '593987654321' });
  assert.ok(ud.ph);
  assert.equal('em' in ud, false);
  assert.equal('fn' in ud, false);
  assert.equal('ctwa_clid' in ud, false);
});
