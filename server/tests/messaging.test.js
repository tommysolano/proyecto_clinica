const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const messaging = require('../utils/messaging');
const whatsappCloud = require('../utils/whatsappCloud');
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

  // Sin ningún entrante REAL no hay ventana, diga lo que diga `lastMessageDirection`.
  // Antes existía un respaldo "si el último mensaje fue entrante, la ventana sale de
  // él" que abría ventanas FANTASMA en los chats recién creados por un envío nuestro
  // (nacían con el default 'in' y `lastMessageAt` = ahora): la UI decía "puedes
  // escribir 24 h" y Meta rechazaba el texto con el error 131047.
  const sinEntrante = messaging.describeWhatsappWindow(
    { channel: 'whatsapp', lastMessageDirection: 'in', lastMessageAt: now },
    'cloud_api',
    now
  );
  assert.equal(sinEntrante.open, false, 'sin entrante real la ventana NUNCA está abierta');
  assert.equal(sinEntrante.expiresAt, null);
  assert.equal(sinEntrante.lastInboundAt, null, 'no se inventa una fecha de entrante');
});

test('la ventana de 24h es POR NÚMERO: la abre a quien le escribieron, no a todos', () => {
  const now = new Date('2026-06-18T09:00:00Z');
  const lastInboundAt = new Date('2026-06-17T10:00:00Z'); // hace 23 h: ventana viva
  const recepcion = '6a61948be2e5e6500a484bc8'; // número al que escribió el contacto
  const api = '6a5698a3b23cf314cab98a81'; // otro número nuestro
  const conv = { channel: 'whatsapp', lastInboundAt, lastInboundAccount: recepcion };

  // Por el número al que escribió: abierta, como toda la vida.
  const mismo = messaging.describeWhatsappWindow(conv, 'cloud_api', now, recepcion);
  assert.equal(mismo.open, true);
  assert.equal(mismo.otherNumber, false);

  // Por OTRO número: Meta no reconoce ninguna ventana ahí. Antes esto se
  // enseñaba como "abierta, te quedan 8 h" y el texto libre se perdía con el
  // error 131047 — el paciente no recibía nada.
  const otro = messaging.describeWhatsappWindow(conv, 'cloud_api', now, api);
  assert.equal(otro.open, false, 'escribir a otro número no abre ventana en este');
  assert.equal(otro.expiresAt, null);
  assert.equal(otro.otherNumber, true, 'y se dice POR QUÉ, que si no parece un fallo');
  assert.equal(
    otro.lastInboundAt.toISOString(),
    lastInboundAt.toISOString(),
    'el "escribió hace un rato" sigue siendo cierto: es la ventana la que no existe aquí'
  );

  // El envío usa la misma regla.
  assert.equal(messaging.isWhatsappWindowOpen(conv, now, recepcion), true);
  assert.equal(messaging.isWhatsappWindowOpen(conv, now, api), false);

  // Chats antiguos, sin saber por dónde entró: no se puede afirmar que esté
  // cerrada. "No lo sé" no puede volverse "cerrada" para media bandeja.
  const antiguo = { channel: 'whatsapp', lastInboundAt };
  assert.equal(messaging.describeWhatsappWindow(antiguo, 'cloud_api', now, api).open, true);

  // Un `window24hExpiresAt` guardado tampoco resucita la ventana en otro número:
  // es justo el campo que arrastraba ventanas fantasma.
  const conCache = { ...conv, window24hExpiresAt: new Date('2026-06-18T10:00:00Z') };
  assert.equal(messaging.describeWhatsappWindow(conCache, 'cloud_api', now, api).open, false);
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

test('WhatsApp Cloud envía respuestas rápidas como botones interactivos', async () => {
  const originalFetch = global.fetch;
  let payload = null;
  global.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.button' }] }) };
  };
  try {
    const result = await whatsappCloud.sendButtons(
      { accessToken: 'token', phoneNumberId: 'phone-id', apiVersion: 'v23.0' },
      '593999999999',
      'Elige una opción',
      [{ id: 'confirmar', providerId: 'wf:enrollment:confirmar', text: 'Confirmar' }]
    );
    assert.equal(result.ok, true);
    assert.equal(payload.type, 'interactive');
    assert.equal(payload.interactive.type, 'button');
    assert.equal(payload.interactive.action.buttons[0].reply.id, 'wf:enrollment:confirmar');
    assert.equal(payload.interactive.action.buttons[0].reply.title, 'Confirmar');
  } finally {
    global.fetch = originalFetch;
  }
});
