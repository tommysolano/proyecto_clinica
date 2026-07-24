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

const {
  extractQrMedia, describeQrNonMedia, findRecentlySentMedia, watchOutgoingMedia, qrMessageId, qrMessageHash,
} = require('../utils/whatsappQrManager').__test;

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

// ─────────────────── chats de número oculto (@lid) ───────────────────

// En estos chats whatsapp-web.js NO expone `id._serialized`, y sin la clave
// completa TODO lo que busca el mensaje por id falla: la descarga del archivo
// (por eso no entraba ninguna foto ni nota de voz) y el botón de reintentar
// ("Invalid serialized message id specified").
test('@lid: la clave del mensaje se reconstruye a partir de sus piezas', () => {
  const msg = {
    _data: {
      id: { fromMe: false, remote: { user: '204496395366461', server: 'lid' }, id: 'ACE14EA2A82FBED950BBB952E4A4AD36' },
    },
  };
  assert.equal(qrMessageId(msg), 'false_204496395366461@lid_ACE14EA2A82FBED950BBB952E4A4AD36');
  assert.equal(qrMessageHash(msg), 'ACE14EA2A82FBED950BBB952E4A4AD36');
});

test('cuando la librería SÍ da la clave completa, se respeta tal cual', () => {
  const msg = { id: { _serialized: 'false_593999@c.us_ABC', id: 'ABC' } };
  assert.equal(qrMessageId(msg), 'false_593999@c.us_ABC');
  assert.equal(qrMessageHash(msg), 'ABC');
});

test('mensaje de grupo: la clave incluye al participante', () => {
  const msg = {
    _data: {
      id: {
        fromMe: true,
        remote: { _serialized: '123-456@g.us' },
        id: 'HASH1',
        participant: { user: '593999', server: 'c.us' },
      },
    },
  };
  assert.equal(qrMessageId(msg), 'true_123-456@g.us_HASH1_593999@c.us');
});

test('sin piezas suficientes no se inventa una clave', () => {
  assert.equal(qrMessageId({ _data: { id: { fromMe: false, id: 'SOLO_HASH' } } }), '');
  assert.equal(qrMessageId({}), '');
});

// ─────────────────── confirmación del envío por evento ───────────────────

function fakeClient() {
  const handlers = {};
  return {
    on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); },
    off: (ev, fn) => { handlers[ev] = (handlers[ev] || []).filter((f) => f !== fn); },
    emit: (ev, arg) => (handlers[ev] || []).forEach((f) => f(arg)),
    count: (ev) => (handlers[ev] || []).length,
  };
}

test('el adjunto que la sesión anuncia se da por enviado (aunque no devuelva id)', () => {
  const client = fakeClient();
  const w = watchOutgoingMedia({ client }, '204496395366461@lid');
  assert.equal(w.id(), '');
  client.emit('message_create', {
    fromMe: true,
    hasMedia: true,
    to: '204496395366461@lid',
    _data: { id: { fromMe: true, remote: { user: '204496395366461', server: 'lid' }, id: 'ENVIADO1' } },
  });
  assert.equal(w.id(), 'true_204496395366461@lid_ENVIADO1');
  w.stop();
  assert.equal(client.count('message_create'), 0, 'deja de escuchar al terminar');
});

test('un mensaje de OTRO chat (o sin adjunto) no confirma nuestro envío', () => {
  const client = fakeClient();
  const w = watchOutgoingMedia({ client }, '593999@c.us');
  client.emit('message_create', { fromMe: true, hasMedia: true, to: '111@c.us', id: { _serialized: 'x' } });
  client.emit('message_create', { fromMe: true, hasMedia: false, to: '593999@c.us', id: { _serialized: 'y' } });
  client.emit('message_create', { fromMe: false, hasMedia: true, to: '593999@c.us', id: { _serialized: 'z' } });
  assert.equal(w.id(), '');
  w.stop();
});

test('ubicaciones y tarjetas de contacto se describen (antes se descartaban)', () => {
  assert.match(describeQrNonMedia({ type: 'location', location: { name: 'Clínica Shiluv' } }), /Ubicación: Clínica Shiluv/);
  assert.match(
    describeQrNonMedia({ type: 'vcard', body: 'BEGIN:VCARD\nFN:Ana Pérez\nEND:VCARD' }),
    /Contacto compartido: Ana Pérez/
  );
  assert.equal(describeQrNonMedia({ type: 'chat', body: 'hola' }), '');
});
