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

test('describeWhatsappWindow: fuente única de verdad de la ventana para la UI', () => {
  const now = new Date('2026-06-18T09:00:00Z');
  const lastInboundAt = new Date('2026-06-17T10:00:00Z'); // ventana viva hasta 18-jun 10:00Z

  // Cloud API, dentro de la ventana → abierta y aplica.
  const open = messaging.describeWhatsappWindow(
    { channel: 'whatsapp', lastInboundAt },
    'cloud_api',
    now
  );
  assert.equal(open.applies, true);
  assert.equal(open.open, true);
  assert.equal(open.expiresAt.toISOString(), '2026-06-18T10:00:00.000Z');
  assert.ok(open.msRemaining > 0);
  assert.equal(open.lastInboundAt.toISOString(), lastInboundAt.toISOString());

  // Cloud API, fuera de la ventana → cerrada.
  const closed = messaging.describeWhatsappWindow(
    { channel: 'whatsapp', lastInboundAt },
    'cloud_api',
    new Date('2026-06-18T10:00:01Z')
  );
  assert.equal(closed.open, false);
  assert.equal(closed.msRemaining, 0);

  // Número QR: la ventana NO aplica, siempre se puede escribir aunque el último
  // entrante sea de hace días.
  const qr = messaging.describeWhatsappWindow(
    { channel: 'whatsapp', lastInboundAt: new Date('2026-06-01T00:00:00Z') },
    'qr',
    now
  );
  assert.equal(qr.applies, false);
  assert.equal(qr.open, true);

  // Sin lastInboundAt pero último mensaje entrante (conversación vieja) → sale de él.
  const legacy = messaging.describeWhatsappWindow(
    { channel: 'whatsapp', lastMessageDirection: 'in', lastMessageAt: lastInboundAt },
    'cloud_api',
    now
  );
  assert.equal(legacy.open, true);
  assert.equal(legacy.lastInboundAt.toISOString(), lastInboundAt.toISOString());
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
