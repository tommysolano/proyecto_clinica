const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const messaging = require('../utils/messaging');
const { verifyMetaSignature } = require('../utils/metaWebhook');

test('computes and checks the WhatsApp 24h window', () => {
  const incomingAt = new Date('2026-06-17T10:00:00Z');
  const expiresAt = messaging.computeWhatsappWindowExpiresAt(incomingAt);

  assert.equal(expiresAt.toISOString(), '2026-06-18T10:00:00.000Z');
  assert.equal(
    messaging.isWhatsappWindowOpen(
      { channel: 'whatsapp', window24hExpiresAt: expiresAt },
      new Date('2026-06-18T09:59:59Z')
    ),
    true
  );
  assert.equal(
    messaging.isWhatsappWindowOpen(
      { channel: 'whatsapp', window24hExpiresAt: expiresAt },
      new Date('2026-06-18T10:00:01Z')
    ),
    false
  );
});

test('detects explicit opt-out keywords without matching normal appointment text', () => {
  assert.equal(messaging.isOptOutText('BAJA'), true);
  assert.equal(messaging.isOptOutText('stop'), true);
  assert.equal(messaging.isOptOutText('Cancelar'), true);
  assert.equal(messaging.isOptOutText('quiero cancelar mi cita'), false);
});

test('maps provider statuses to local delivery statuses', () => {
  assert.equal(messaging.mapProviderStatus('sent'), 'sent');
  assert.equal(messaging.mapProviderStatus('delivered'), 'delivered');
  assert.equal(messaging.mapProviderStatus('read'), 'read');
  assert.equal(messaging.mapProviderStatus('failed'), 'failed');
  assert.equal(messaging.mapProviderStatus('unknown'), null);
});

test('delivery status only moves forward and never revives a failed message', () => {
  const s = messaging.shouldApplyStatus;
  // Avanza normalmente.
  assert.equal(s('queued', 'sent'), true);
  assert.equal(s('sent', 'delivered'), true);
  assert.equal(s('delivered', 'read'), true);
  assert.equal(s(undefined, 'sent'), true);
  // NO retrocede por callbacks fuera de orden.
  assert.equal(s('delivered', 'sent'), false);
  assert.equal(s('read', 'delivered'), false);
  assert.equal(s('read', 'sent'), false);
  assert.equal(s('sent', 'sent'), false);
  // 'failed' es terminal: un estado tardío NO lo revive ("dice enviado/entregado
  // cuando nunca llegó").
  assert.equal(s('failed', 'sent'), false);
  assert.equal(s('failed', 'delivered'), false);
  assert.equal(s('failed', 'read'), false);
  // Un 'failed' entrante gana sobre queued/sent, pero NO borra una entrega real.
  assert.equal(s('sent', 'failed'), true);
  assert.equal(s('queued', 'failed'), true);
  assert.equal(s('delivered', 'failed'), false);
  assert.equal(s('read', 'failed'), false);
});

test('verifies Meta X-Hub-Signature-256 HMAC', () => {
  const rawBody = Buffer.from(JSON.stringify({ hello: 'world' }));
  const appSecret = 'secret';
  const signature = `sha256=${crypto
    .createHmac('sha256', appSecret)
    .update(rawBody)
    .digest('hex')}`;

  assert.equal(verifyMetaSignature({ rawBody, signature, appSecret }).ok, true);
  assert.equal(
    verifyMetaSignature({ rawBody, signature: 'sha256=bad', appSecret }).ok,
    false
  );
});
