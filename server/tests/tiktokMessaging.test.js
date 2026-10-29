const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifySignature, parseWebhookEvent, normalizeMessage } = require('../utils/tiktokMessaging');

const SECRET = 'app-secret-de-prueba';
const firmar = (body, t) => `t=${t},s=${crypto.createHmac('sha256', SECRET).update(`${t}.${body}`).digest('hex')}`;

test('verifySignature acepta la firma de TikTok (t=..,s=.. sobre "t.cuerpo")', () => {
  const body = JSON.stringify({ event: 'x', content: '{}' });
  const t = Math.floor(Date.now() / 1000);
  assert.deepEqual(verifySignature({ rawBody: Buffer.from(body), header: firmar(body, t), secret: SECRET }), { ok: true });
});

test('verifySignature rechaza cuerpo alterado, secreto ausente, cabecera mala y firma vieja', () => {
  const body = '{"a":1}';
  const t = Math.floor(Date.now() / 1000);
  assert.equal(verifySignature({ rawBody: '{"a":2}', header: firmar(body, t), secret: SECRET }).reason, 'bad_signature');
  assert.equal(verifySignature({ rawBody: body, header: firmar(body, t), secret: '' }).reason, 'app_secret_not_configured');
  assert.equal(verifySignature({ rawBody: body, header: undefined, secret: SECRET }).reason, 'missing_signature');
  assert.equal(verifySignature({ rawBody: body, header: 'basura', secret: SECRET }).reason, 'malformed_signature');
  const vieja = t - 3600;
  assert.equal(verifySignature({ rawBody: body, header: firmar(body, vieja), secret: SECRET }).reason, 'stale_signature');
});

test('parseWebhookEvent lee el sobre con content serializado', () => {
  const ev = parseWebhookEvent({
    client_key: 'app',
    event: 'direct_message',
    create_time: 1761600000,
    user_openid: 'biz-1',
    content: JSON.stringify({ conversation_id: 'abc+DEF==', message_id: 'm-9', text: { body: 'hola' } }),
  });
  assert.equal(ev.conversationId, 'abc+DEF==');
  assert.equal(ev.messageId, 'm-9');
  assert.equal(ev.businessId, 'biz-1');
  assert.equal(ev.createTime, 1761600000);
});

test('parseWebhookEvent acepta el mensaje anidado y descarta avisos sin conversación', () => {
  const ev = parseWebhookEvent({ content: { message: { conversation_id: 'c1', message_id: 'm1' } } });
  assert.equal(ev.conversationId, 'c1');
  assert.equal(ev.messageId, 'm1');
  assert.equal(parseWebhookEvent({ event: 'otra_cosa', content: '{}' }), null);
  assert.equal(parseWebhookEvent(null), null);
});

test('normalizeMessage: texto del contacto con su nombre, y el de la empresa marcado', () => {
  const participants = [
    { role: 'PERSONAL_ACCOUNT', id: 'u1', display_name: 'Ana' },
    { role: 'BUSINESS_ACCOUNT', id: 'biz-1', display_name: 'Clínica' },
  ];
  const deContacto = normalizeMessage(
    { message_id: 'm1', conversation_id: 'c1', sender: 'u1', message_type: 'TEXT', text: { body: 'Quiero una cita' }, timestamp: 1 },
    participants,
    'biz-1'
  );
  assert.equal(deContacto.fromBusiness, false);
  assert.equal(deContacto.contactName, 'Ana');
  assert.equal(deContacto.body, 'Quiero una cita');

  const deEmpresa = normalizeMessage({ message_id: 'm2', sender: 'biz-1', message_type: 'TEXT', text: { body: 'ok' } }, participants, 'biz-1');
  assert.equal(deEmpresa.fromBusiness, true);
});

test('normalizeMessage: imagen pide descarga y lo no soportado deja aviso legible', () => {
  const img = normalizeMessage({ message_id: 'm3', message_type: 'IMAGE', image: { media_id: 'md1' }, from_user: { role: 'PERSONAL_ACCOUNT' } });
  assert.deepEqual(img.media, { type: 'image', mediaId: 'md1' });
  assert.equal(img.body, '');
  const otro = normalizeMessage({ message_id: 'm4', message_type: 'OTHER' });
  assert.match(otro.body, /no compatible/);
});
