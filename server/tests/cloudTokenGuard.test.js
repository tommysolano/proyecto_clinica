/**
 * Guardia del token Cloud API: si el token guardado quedó cifrado con una
 * SECRETS_KEY que este servidor NO tiene (cambió o falta), decryptSecret devuelve el
 * blob `enc:v1:…` y ANTES se enviaba a Meta → "Authentication Error / Cannot parse
 * access token" (críptico). Ahora se corta con un mensaje accionable y no se llama a Meta.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

// Sin SECRETS_KEY en el entorno de test: un token `enc:v1:…` NO se puede descifrar.
delete process.env.SECRETS_KEY;
const gateway = require('../utils/whatsappGateway');

test('cloudTokenError: token cifrado ilegible (SECRETS_KEY ausente/cambiada) → error accionable', () => {
  const acc = { label: 'Recepcion', connectionType: 'cloud_api', phoneNumberId: '123', accessToken: 'enc:v1:AAA:BBB:CCC' };
  const err = gateway.cloudTokenError(acc);
  assert.ok(err, 'debe devolver un error, no null');
  assert.equal(err.ok, false);
  assert.equal(err.errorCode, 'token_undecryptable');
  assert.match(err.error, /SECRETS_KEY|Configuración → WhatsApp|vuelve a guardar/i);
});

test('cloudTokenError: token en texto plano (legacy, sin cifrar) pasa sin error', () => {
  const acc = { label: 'Recepcion', connectionType: 'cloud_api', phoneNumberId: '123', accessToken: 'EAAG_un_token_plano' };
  assert.equal(gateway.cloudTokenError(acc), null, 'un token plano legible no se bloquea');
});

test('sendTemplate: con token ilegible NO llama a Meta y devuelve el error de token', async () => {
  const acc = { label: 'Recepcion', connectionType: 'cloud_api', phoneNumberId: '123', accessToken: 'enc:v1:AAA:BBB:CCC' };
  const r = await gateway.sendTemplate(acc, '593999111222', '24h_flujo', 'es', []);
  assert.equal(r.ok, false);
  assert.equal(r.errorCode, 'token_undecryptable');
});
