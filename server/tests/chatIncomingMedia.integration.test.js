/**
 * Media ENTRANTE del chat (fotos, notas de voz y archivos que manda el paciente).
 *
 * Bugs reales que cubren estas pruebas (número QR con 1600+ mensajes recibidos y
 * CERO archivos guardados en toda la historia de la base):
 *
 *  1. Si la descarga del archivo fallaba, el mensaje se guardaba SIN tipo de media
 *     → burbuja completamente vacía (Cloud API), o directamente se descartaba y
 *     NUNCA aparecía en el chat (QR). El agente no se enteraba de que el paciente
 *     le había mandado una foto.
 *  2. El adjunto guardado con la cabecera del navegador
 *     (`data:audio/ogg;codecs=opus;base64,…`) no se podía servir: el parseo antiguo
 *     devolvía 415 y la nota de voz no se escuchaba (y Meta la rechazaba con 131053).
 *  3. Ubicaciones y tarjetas de contacto llegaban como burbuja vacía.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const media = require('../controllers/mediaController');
const Message = require('../models/Message');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const WhatsappAccount = require('../models/WhatsappAccount');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const PHONE = '593999888777';

// Respuesta express simulada, suficiente para mediaController.serve.
function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(k, v) { this.headers[String(k).toLowerCase()] = v; return this; },
    status(c) { this.statusCode = c; return this; },
    send(b) { this.body = b; return this; },
    end() { return this; },
  };
}

// ───────────────── media entrante que no se pudo descargar ─────────────────

test('QR: una foto que la sesión no logró descargar SE GUARDA igual (no desaparece)', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await chat.ingestExternalMessage({
    clinicId,
    channel: 'whatsapp',
    externalUserId: `${PHONE}@c.us`,
    phone: PHONE,
    body: '',
    externalId: 'qr_1',
    account: null,
    // Lo que devuelve extractQrMedia cuando WhatsApp Web no entrega los bytes.
    media: { type: 'image', unavailable: true, error: 'WhatsApp Web aún no tenía la media descargada', caption: '' },
  });

  const msgs = await Message.find({ clinic: clinicId });
  assert.equal(msgs.length, 1, 'el mensaje NO debe perderse');
  assert.equal(msgs[0].mediaType, 'image', 'se conserva QUÉ llegó, aunque falte el archivo');
  assert.ok(!msgs[0].mediaUrl, 'sin archivo');
  assert.equal(msgs[0].errorCode, 'media_unavailable');
  assert.match(msgs[0].errorMessage, /media descargada/);
});

test('Cloud API: si Meta no entrega el archivo, la burbuja dice qué era (no queda vacía)', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const account = await WhatsappAccount.create({
    label: 'Recepción', connectionType: 'cloud_api', phoneNumberId: '123',
    accessToken: 'TOKEN', enabled: true,
  });

  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'Media not found' } }) });
  try {
    await chat.ingestExternalMessage({
      clinicId,
      channel: 'whatsapp',
      externalUserId: PHONE,
      phone: PHONE,
      body: '',
      externalId: 'wamid.1',
      account,
      media: { type: 'audio', id: 'MEDIA_1' },
    });
  } finally {
    global.fetch = origFetch;
  }

  const msgs = await Message.find({ clinic: clinicId });
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].mediaType, 'audio');
  assert.equal(msgs[0].errorCode, 'media_unavailable');
  assert.ok(msgs[0].errorMessage, 'debe explicar por qué no está el archivo');
});

test('Cloud API: sin cuenta resuelta (phone_number_id desconocido) el archivo no se pierde en silencio', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await chat.ingestExternalMessage({
    clinicId, channel: 'whatsapp', externalUserId: PHONE, phone: PHONE, body: '',
    externalId: 'wamid.2', account: null, media: { type: 'image', id: 'MEDIA_2' },
  });
  const msg = await Message.findOne({ clinic: clinicId });
  assert.equal(msg.mediaType, 'image');
  assert.equal(msg.errorCode, 'media_unavailable');
});

test('media entrante OK: se guarda el archivo y no se marca ningún error', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await chat.ingestExternalMessage({
    clinicId, channel: 'whatsapp', externalUserId: `${PHONE}@c.us`, phone: PHONE,
    body: '', externalId: 'qr_ok', account: null,
    media: { type: 'image', dataUrl: 'data:image/jpeg;base64,/9j/4AAQ', size: 1234, caption: 'mira' },
  });
  const msg = await Message.findOne({ clinic: clinicId });
  assert.equal(msg.mediaType, 'image');
  assert.equal(msg.mediaUrl, 'data:image/jpeg;base64,/9j/4AAQ');
  assert.equal(msg.body, 'mira', 'el pie de foto es el cuerpo del mensaje');
  assert.equal(msg.errorCode, '');
});

// ───────────────── recuperar un archivo que falló ─────────────────

test('reintentar descarga: el archivo se recupera y la burbuja deja de estar en error', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const account = await WhatsappAccount.create({
    label: 'Recepción', connectionType: 'cloud_api', phoneNumberId: '123', accessToken: 'TOKEN', enabled: true,
  });
  const Conversation = require('../models/Conversation');
  const conv = await Conversation.create({
    clinic: clinicId, phone: PHONE, channel: 'whatsapp', whatsappAccount: account._id,
  });
  const msg = await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in', mediaType: 'audio',
    mediaExternalId: 'MEDIA_9', errorCode: 'media_unavailable', errorMessage: 'r',
  });

  const origFetch = global.fetch;
  global.fetch = async (url) =>
    String(url).includes('graph.facebook.com')
      ? { ok: true, json: async () => ({ url: 'https://lookaside.fb/audio', mime_type: 'audio/ogg' }) }
      : { ok: true, arrayBuffer: async () => Buffer.from('OggS-bytes') };
  try {
    const r = await H.runController(
      chat.retryMessageMedia,
      H.mockReq(clinicId, userId, {}, { params: { id: String(conv._id), messageId: String(msg._id) } })
    );
    assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
    assert.match(r.payload.mediaUrl, /^data:audio\/ogg;base64,/);
    assert.equal(r.payload.errorCode, '', 'se limpia el error al recuperarlo');
  } finally {
    global.fetch = origFetch;
  }
});

test('reintentar descarga: si Meta sigue sin darlo, responde 409 con el motivo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const account = await WhatsappAccount.create({
    label: 'Recepción', connectionType: 'cloud_api', phoneNumberId: '123', accessToken: 'TOKEN', enabled: true,
  });
  const Conversation = require('../models/Conversation');
  const conv = await Conversation.create({
    clinic: clinicId, phone: PHONE, channel: 'whatsapp', whatsappAccount: account._id,
  });
  const msg = await Message.create({
    clinic: clinicId, conversation: conv._id, direction: 'in', mediaType: 'image', mediaExternalId: 'MEDIA_X',
  });

  const origFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: { message: 'Media not found' } }) });
  try {
    const r = await H.runController(
      chat.retryMessageMedia,
      H.mockReq(clinicId, userId, {}, { params: { id: String(conv._id), messageId: String(msg._id) } })
    );
    assert.equal(r.statusCode, 409);
    assert.match(r.payload.message, /Media not found/);
  } finally {
    global.fetch = origFetch;
  }
});

// ───────────────── servidor de media (escuchar la nota de voz) ─────────────────

test('serve: una nota de voz guardada con ;codecs=opus SÍ se puede reproducir', async () => {
  const { clinicId } = await H.seedClinic();
  // Cabecera tal cual la produce Firefox (MediaRecorder) — antes daba 415.
  const img = await ChatGalleryImage.create({
    clinic: clinicId, name: 'nota-de-voz.ogg', mimeType: 'audio/ogg',
    dataUrl: 'data:audio/ogg;codecs=opus;base64,T2dnUwACAAAA',
  });
  const res = mockRes();
  await media.serve({ params: { id: String(img._id) }, headers: {} }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'audio/ogg');
  assert.equal(res.headers['accept-ranges'], 'bytes');
  assert.equal(res.body.subarray(0, 4).toString(), 'OggS');
});

test('serve: responde a peticiones por rango (Safari no reproduce audio sin esto)', async () => {
  const { clinicId } = await H.seedClinic();
  const img = await ChatGalleryImage.create({
    clinic: clinicId, name: 'a.ogg', mimeType: 'audio/ogg',
    dataUrl: `data:audio/ogg;base64,${Buffer.from('0123456789').toString('base64')}`,
  });
  const res = mockRes();
  await media.serve({ params: { id: String(img._id) }, headers: { range: 'bytes=2-5' } }, res);
  assert.equal(res.statusCode, 206);
  assert.equal(res.headers['content-range'], 'bytes 2-5/10');
  assert.equal(res.body.toString(), '2345');
});

test('serve: un rango imposible responde 416, no bytes basura', async () => {
  const { clinicId } = await H.seedClinic();
  const img = await ChatGalleryImage.create({
    clinic: clinicId, name: 'a.ogg', mimeType: 'audio/ogg',
    dataUrl: `data:audio/ogg;base64,${Buffer.from('0123456789').toString('base64')}`,
  });
  const res = mockRes();
  await media.serve({ params: { id: String(img._id) }, headers: { range: 'bytes=50-60' } }, res);
  assert.equal(res.statusCode, 416);
});

// ───────────────── mensajes que no son texto ni media ─────────────────

test('el webhook describe ubicaciones, contactos y reacciones (antes: burbuja vacía)', () => {
  const { describeNonMediaMessage } = chat;
  assert.match(describeNonMediaMessage({ location: { name: 'Clínica Shiluv' } }), /Ubicación: Clínica Shiluv/);
  assert.match(
    describeNonMediaMessage({ contacts: [{ name: { formatted_name: 'Ana Pérez' } }] }),
    /Contacto compartido: Ana Pérez/
  );
  assert.match(describeNonMediaMessage({ reaction: { emoji: '❤️' } }), /reacción/);
  assert.match(describeNonMediaMessage({ type: 'unsupported' }), /no permite mostrar/);
  assert.equal(describeNonMediaMessage({ text: { body: 'hola' } }), '', 'un texto normal no se describe');
});
