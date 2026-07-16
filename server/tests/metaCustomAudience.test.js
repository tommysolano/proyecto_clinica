const test = require('node:test');
const assert = require('node:assert/strict');
const ca = require('../utils/metaCustomAudience');
const mc = require('../utils/metaConversions');

test('buildAudienceData: hashea identificadores (SHA-256) y arma el schema multi-clave', () => {
  const out = ca.buildAudienceData({
    email: 'John@Example.com ',
    phone: '099 123 4567',
    firstName: 'María',
    lastName: 'Pérez',
  });
  assert.deepEqual(out.schema, ['EMAIL', 'PHONE', 'FN', 'LN']);
  assert.equal(out.data.length, 1);
  const [em, ph, fn, ln] = out.data[0];
  // email en minúsculas y sin espacios; teléfono solo dígitos.
  assert.equal(em, mc.hashSha256('john@example.com'));
  assert.equal(ph, mc.hashSha256('0991234567'));
  assert.equal(fn, mc.hashSha256('maría'));
  assert.equal(ln, mc.hashSha256('pérez'));
  assert.match(em, /^[a-f0-9]{64}$/);
});

test('buildAudienceData: solo teléfono también es un identificador válido', () => {
  const out = ca.buildAudienceData({ whatsapp: '0991234567' });
  assert.deepEqual(out.schema, ['PHONE']);
  assert.equal(out.data[0][0], mc.hashSha256('0991234567'));
});

test('buildAudienceData: sin identificadores devuelve null (no se envía nada a Meta)', () => {
  assert.equal(ca.buildAudienceData({ firstName: '' }), null);
  assert.equal(ca.buildAudienceData({}), null);
  assert.equal(ca.buildAudienceData(null), null);
});
