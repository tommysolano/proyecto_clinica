/**
 * ENVÍO POR QR QUE "NO SE PUDO CONFIRMAR": qué se hace en vez de perder el mensaje.
 *
 * CASO REAL (ago-2026): la pestaña de WhatsApp Web se recargó a mitad de un envío
 * de una automatización. El sistema pintó la burbuja roja ("La sesión de WhatsApp
 * Web se recargó en mitad del envío…"), NO reintentó, siguió con el paso siguiente
 * del flujo y ese mensaje se perdió para siempre.
 *
 * Lo que se fija aquí:
 *   1. Antes de dar un envío por fallido se COMPRUEBA si salió: lo que anunció la
 *      propia sesión (message_create) y, si calla, el chat.
 *   2. "No lo encuentro" solo vale si se pudo LEER el chat (`checked`). Con la
 *      sesión caída no se puede afirmar nada.
 *   3. Un envío sin confirmar queda apuntado: el siguiente intento del MISMO texto
 *      al mismo chat mira primero el chat, así el reintento no duplica el mensaje.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const qr = require('../utils/whatsappQrManager');

const {
  findRecentlySent, watchOutgoing, confirmAfterFailure, isSessionGlitch,
  pendingSends, rememberPending, takePending, sendFingerprint, sameText,
} = qr.__test;

test.beforeEach(() => pendingSends.clear());

/** Sesión falsa cuyo chat contiene `messages`. */
function fakeEntry(messages) {
  return { client: { getChatById: async () => ({ fetchMessages: async () => messages }) } };
}

const textoDe = (t) => (m) => !m.hasMedia && sameText(m.body, t);

// ─────────────────────────── leer el chat ───────────────────────────

test('el texto que sí salió se encuentra en el chat', async () => {
  const now = Math.floor(Date.now() / 1000);
  const entry = fakeEntry([
    { fromMe: false, body: 'hola?', timestamp: now - 60, id: { _serialized: 'entrante' } },
    { fromMe: true, body: 'Tu cita es mañana', timestamp: now, id: { _serialized: 'true_593@c.us_OK' } },
  ]);
  const r = await findRecentlySent(entry, '593999@c.us', Date.now(), {
    matches: textoDe('Tu cita es mañana'), waits: [0],
  });
  assert.equal(r.id, 'true_593@c.us_OK');
  assert.equal(r.checked, true);
});

test('otro texto nuestro NO cuenta como confirmación', async () => {
  const now = Math.floor(Date.now() / 1000);
  const entry = fakeEntry([{ fromMe: true, body: 'otra cosa', timestamp: now, id: { _serialized: 'x' } }]);
  const r = await findRecentlySent(entry, '593999@c.us', Date.now(), {
    matches: textoDe('Tu cita es mañana'), waits: [0],
  });
  assert.equal(r.id, '');
  assert.equal(r.checked, true, 'el chat SÍ se pudo leer: se puede afirmar que no salió');
});

test('si el chat no se puede leer, NO se afirma que el mensaje no salió', async () => {
  const entry = { client: { getChatById: async () => { throw new Error('Session closed'); } } };
  const r = await findRecentlySent(entry, '593999@c.us', Date.now(), { matches: () => true, waits: [0] });
  assert.equal(r.id, '');
  assert.equal(r.checked, false, 'sin lectura no hay veredicto: reenviar a ciegas duplicaría');
});

// ───────────────── confirmación por el evento de la sesión ─────────────────

function fakeClient() {
  const handlers = {};
  return {
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    off: (ev, fn) => { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); },
    emit: (ev, arg) => (handlers[ev] || []).forEach((f) => f(arg)),
  };
}

test('el texto que la sesión anuncia se da por enviado aunque el envío lanzara', async () => {
  const client = fakeClient();
  const entry = { client };
  const w = watchOutgoing(entry, '593999@c.us', textoDe('Tu cita es mañana'));
  client.emit('message_create', {
    fromMe: true, body: 'Tu cita es mañana', to: '593999@c.us', id: { _serialized: 'true_593@c.us_EVT' },
  });
  const conf = await confirmAfterFailure(entry, w, '593999@c.us', Date.now(), textoDe('Tu cita es mañana'));
  w.stop();
  assert.equal(conf.wamid, 'true_593@c.us_EVT');
  assert.equal(conf.checked, true);
});

test('un mensaje de otro chat o con otro texto no confirma nuestro envío', () => {
  const client = fakeClient();
  const w = watchOutgoing({ client }, '593999@c.us', textoDe('Tu cita es mañana'));
  client.emit('message_create', { fromMe: true, body: 'Tu cita es mañana', to: '111@c.us', id: { _serialized: 'a' } });
  client.emit('message_create', { fromMe: true, body: 'otro texto', to: '593999@c.us', id: { _serialized: 'b' } });
  client.emit('message_create', { fromMe: false, body: 'Tu cita es mañana', to: '593999@c.us', id: { _serialized: 'c' } });
  assert.equal(w.id(), '');
  w.stop();
});

// ─────────────────── el reintento no puede duplicar ───────────────────

test('un envío sin confirmar queda apuntado para que el reintento lo compruebe', () => {
  const huella = sendFingerprint('Tu cita es mañana');
  rememberPending('cuenta1', '593999@c.us', huella, Date.now());
  const p = takePending('cuenta1', '593999@c.us', huella);
  assert.ok(p, 'el reintento lo encuentra');
  assert.equal(takePending('cuenta1', '593999@c.us', huella), null, 'se consume una sola vez');
});

test('el apunte no confunde chats ni textos distintos', () => {
  rememberPending('cuenta1', '593999@c.us', sendFingerprint('A'), Date.now());
  assert.equal(takePending('cuenta1', '593888@c.us', sendFingerprint('A')), null, 'otro chat');
  assert.equal(takePending('cuenta1', '593999@c.us', sendFingerprint('B')), null, 'otro texto');
  assert.equal(takePending('cuenta2', '593999@c.us', sendFingerprint('A')), null, 'otro número nuestro');
});

test('un apunte viejo (más de 4 h) ya no frena el envío', () => {
  const huella = sendFingerprint('Tu cita es mañana');
  rememberPending('cuenta1', '593999@c.us', huella, Date.now() - 5 * 60 * 60 * 1000);
  assert.equal(takePending('cuenta1', '593999@c.us', huella), null, 'caducó: se envía normal');
});

// ─────────────────── qué errores merecen reintento ───────────────────

test('los tropiezos de la sesión se distinguen de un rechazo real', () => {
  assert.equal(isSessionGlitch(new Error('Protocol error (Runtime.callFunctionOn): Promise was collected')), true);
  assert.equal(isSessionGlitch(new Error('Execution context was destroyed')), true);
  assert.equal(isSessionGlitch(new Error('Session closed')), true);
  assert.equal(isSessionGlitch(new Error('Tiempo agotado enviando el mensaje (la sesión puede estar inestable)')), true);
  assert.equal(isSessionGlitch(new Error('El número 0999 no está en WhatsApp')), false);
});
