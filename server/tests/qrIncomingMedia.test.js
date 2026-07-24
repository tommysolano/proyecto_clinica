/**
 * Descarga de la media ENTRANTE por el número QR (whatsapp-web.js).
 *
 * Causa raíz del "no vemos las fotos que nos mandan": WhatsApp Web emite el
 * mensaje ANTES de terminar de bajar el archivo (mediaStage 'FETCHING') y
 * `downloadMedia()` devuelve `undefined` en ese instante. Se hacía UN solo
 * intento y, al fallar, el mensaje entero se descartaba sin dejar rastro: el
 * número QR acumuló 1600+ mensajes recibidos y CERO archivos guardados.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const { extractQrMedia, describeQrNonMedia, findRecentlySentMedia } = require('../utils/whatsappQrManager').__test;

// Sin esperas reales: los tiempos de reintento se inyectan.
const FAST = { retryDelays: [0, 0, 0] };

function fakeMsg({ type = 'image', attempts = [], body = '', size = 0 } = {}) {
  let i = 0;
  return {
    hasMedia: true,
    type,
    body,
    id: { _serialized: 'false_5939@c.us_ABC' },
    _data: { size },
    downloadMedia: async () => {
      const r = attempts[i];
      i += 1;
      if (r instanceof Error) throw r;
      return r;
    },
    get intentos() { return i; },
  };
}

test('la foto que aún no estaba descargada se REINTENTA y se recupera', async () => {
  // 1º y 2º intento: WhatsApp Web todavía no tiene los bytes (undefined).
  const msg = fakeMsg({ attempts: [undefined, undefined, { data: 'QUJD', mimetype: 'image/jpeg' }] });
  const media = await extractQrMedia(msg, null, FAST);
  assert.equal(media.type, 'image');
  assert.equal(media.dataUrl, 'data:image/jpeg;base64,QUJD');
  assert.equal(media.unavailable, undefined);
  assert.equal(msg.intentos, 3, 'debe reintentar hasta conseguirla');
});

test('si la descarga falla siempre, el mensaje NO se pierde: queda marcado como no disponible', async () => {
  const msg = fakeMsg({ attempts: [undefined, new Error('boom'), undefined] });
  const media = await extractQrMedia(msg, null, FAST);
  assert.equal(media.type, 'image', 'se conserva el tipo para poder mostrar "📷 Foto (no disponible)"');
  assert.equal(media.dataUrl, undefined);
  assert.equal(media.unavailable, true);
  assert.ok(media.error, 'debe explicar el motivo');
});

test('la nota de voz (ptt) se guarda como audio y con la cabecera limpia', async () => {
  // whatsapp-web.js devuelve el mime CON parámetros; en un data URL eso lo rompe.
  const msg = fakeMsg({ type: 'ptt', attempts: [{ data: 'T2dnUw==', mimetype: 'audio/ogg; codecs=opus' }] });
  const media = await extractQrMedia(msg, null, FAST);
  assert.equal(media.type, 'audio');
  assert.equal(media.dataUrl, 'data:audio/ogg;base64,T2dnUw==');
});

test('un archivo enorme no se guarda en Mongo, pero el mensaje sigue apareciendo', async () => {
  // ~12 MB en base64: por encima del tope (reventaría el documento BSON de 16 MB).
  const msg = fakeMsg({ type: 'video', attempts: [{ data: 'A'.repeat(12 * 1024 * 1024), mimetype: 'video/mp4' }] });
  const media = await extractQrMedia(msg, null, FAST);
  assert.equal(media.type, 'video');
  assert.equal(media.unavailable, true);
  assert.match(media.error, /demasiado grande/i);
});

test('un mensaje sin media devuelve null (no inventa adjuntos)', async () => {
  const media = await extractQrMedia({ hasMedia: false, type: 'chat', body: 'hola' }, null, FAST);
  assert.equal(media, null);
});

test('el documento conserva su nombre real y el pie de foto viaja como caption', async () => {
  const msg = fakeMsg({
    type: 'document',
    body: 'te mando el reporte',
    attempts: [{ data: 'QUJD', mimetype: 'application/pdf', filename: 'reporte julio.pdf' }],
  });
  const media = await extractQrMedia(msg, null, FAST);
  assert.equal(media.type, 'document');
  assert.equal(media.filename, 'reporte julio.pdf');
  assert.equal(media.caption, 'te mando el reporte');
});

// ─────────────────── verificación del envío de adjuntos (salientes) ───────────────────

// whatsapp-web.js devuelve `undefined` si su colección interna aún no tiene el
// mensaje al terminar `sendMessage`, aunque YA lo haya puesto a enviar: el video
// le llegaba al contacto y el sistema lo marcaba fallido (y reintentar duplicaba).
function fakeEntry(messages) {
  return {
    client: {
      getChatById: async () => ({ fetchMessages: async () => messages }),
    },
  };
}

test('el video que sí salió se confirma leyendo el chat (no se marca fallido)', async () => {
  const now = Math.floor(Date.now() / 1000);
  const entry = fakeEntry([
    { fromMe: false, hasMedia: false, timestamp: now - 300, id: { _serialized: 'viejo_entrante' } },
    { fromMe: true, hasMedia: true, timestamp: now, id: { _serialized: 'true_593@c.us_NUEVO' } },
  ]);
  const wamid = await findRecentlySentMedia(entry, '593999@c.us', Date.now());
  assert.equal(wamid, 'true_593@c.us_NUEVO');
});

test('si en el chat no hay ningún adjunto nuestro reciente, el envío sí se da por fallido', async () => {
  const now = Math.floor(Date.now() / 1000);
  const entry = fakeEntry([
    // Adjunto NUESTRO pero de hace una hora: no es el que acabamos de mandar.
    { fromMe: true, hasMedia: true, timestamp: now - 3600, id: { _serialized: 'true_593@c.us_VIEJO' } },
    // Y un entrante con media (del contacto): tampoco cuenta.
    { fromMe: false, hasMedia: true, timestamp: now, id: { _serialized: 'entrante' } },
  ]);
  const wamid = await findRecentlySentMedia(entry, '593999@c.us', Date.now());
  assert.equal(wamid, '');
});

test('si el chat no se puede leer, no se inventa una confirmación', async () => {
  const entry = { client: { getChatById: async () => { throw new Error('sesión caída'); } } };
  const wamid = await findRecentlySentMedia(entry, '593999@c.us', Date.now());
  assert.equal(wamid, '');
});

test('ubicaciones y tarjetas de contacto se describen (antes se descartaban)', () => {
  assert.match(describeQrNonMedia({ type: 'location', location: { name: 'Clínica Shiluv' } }), /Ubicación: Clínica Shiluv/);
  assert.match(
    describeQrNonMedia({ type: 'vcard', body: 'BEGIN:VCARD\nFN:Ana Pérez\nEND:VCARD' }),
    /Contacto compartido: Ana Pérez/
  );
  assert.equal(describeQrNonMedia({ type: 'chat', body: 'hola' }), '');
});
