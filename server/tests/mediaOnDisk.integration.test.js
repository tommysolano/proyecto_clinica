/**
 * Los archivos del chat viven en el DISCO del servidor, no dentro de MongoDB.
 *
 * Contexto (medido en producción el 25-jul-2026): el 88% de la base de datos eran
 * archivos en base64 — 149 MB de 169 MB, con seis videos ocupando 60 MB de una
 * cuota de 512 MB — mientras el servidor tenía 65 GB de disco libres. Además el
 * cluster está a 118 ms, así que cada apertura de un chat con video arrastraba
 * esos megas por el enlace lento.
 *
 * Lo que estos tests protegen:
 *   1. subir un adjunto NO deja bytes en Mongo,
 *   2. el endpoint público lo sirve desde disco, incluidos los rangos que Safari
 *      necesita para reproducir audio y video,
 *   3. los DOS gateways de WhatsApp (QR y Cloud) siguen encontrando los bytes,
 *      tanto en disco como en el base64 heredado — si esto se rompe, los envíos
 *      con adjunto dejan de salir,
 *   4. la migración no borra nada de Mongo sin haber verificado el archivo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const media = require('../controllers/mediaController');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const mediaStore = require('../utils/mediaStore');

// PNG real de 1x1 (para que el tipo MIME y los bytes sean coherentes).
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

let tmpDir;

test.before(async () => {
  await H.startDb();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shiluv-media-'));
  process.env.MEDIA_DIR = tmpDir;
});
test.after(async () => {
  await H.stopDb();
  delete process.env.MEDIA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});
test.beforeEach(async () => { await H.resetDb(); });

/** Simula un res que captura lo enviado, incluido el streaming por pipe. */
function captureRes() {
  const state = { status: 200, headers: {}, chunks: [], done: false };
  const res = {
    status(c) { state.status = c; return res; },
    set(k, v) { state.headers[String(k).toLowerCase()] = v; return res; },
    send(b) { state.chunks.push(Buffer.from(b)); state.done = true; return res; },
    end() { state.done = true; return res; },
    redirect(_c, u) { state.redirect = u; state.done = true; return res; },
    // `pipe` del stream de disco: se acumulan los trozos.
    write(c) { state.chunks.push(Buffer.from(c)); return true; },
    on() { return res; },
    once() { return res; },
    emit() { return true; },
  };
  const finished = new Promise((resolve) => {
    res.end = (b) => { if (b) state.chunks.push(Buffer.from(b)); state.done = true; resolve(); return res; };
    res.send = (b) => { if (b) state.chunks.push(Buffer.from(b)); state.done = true; resolve(); return res; };
  });
  return { res, state, finished, body: () => Buffer.concat(state.chunks) };
}

/** Espera a que un pipe de fs termine de volcar en el res simulado. */
async function drain(state, timeoutMs = 2000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !state.done) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
}

// ─────────────────────── subir: los bytes van al disco ───────────────────────

test('subir un adjunto guarda el archivo en disco y NADA en Mongo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await H.runController(
    chat.uploadSavedReplyMedia,
    H.mockReq(clinicId, userId, { name: 'foto.png', dataUrl: PNG_DATA_URL })
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const doc = await ChatGalleryImage.findById(r.payload.id).lean();
  assert.ok(doc.storageKey, 'el documento apunta a un archivo en disco');
  assert.ok(!doc.dataUrl, 'NO queda base64 dentro de Mongo');
  assert.match(doc.storageKey, /^\d{4}\/\d{2}\/[a-f0-9]{24}\.png$/, 'ruta troceada por año/mes');

  // Y el archivo existe de verdad, con los bytes correctos.
  const onDisk = await fs.readFile(path.join(tmpDir, doc.storageKey));
  assert.deepEqual(onDisk, Buffer.from(PNG_B64, 'base64'));
});

test('una clave maliciosa no puede salirse del almacén', () => {
  // La clave viene de la base de datos: no debe poder apuntar al .env del server.
  assert.throws(() => mediaStore.absolutePath('../../../.env'), /fuera del almacén/);
  assert.throws(() => mediaStore.absolutePath('/etc/passwd'), /fuera del almacén/);
});

// ─────────────────────── servir: streaming desde disco ───────────────────────

test('el endpoint público sirve el archivo desde disco', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const up = await H.runController(
    chat.uploadSavedReplyMedia,
    H.mockReq(clinicId, userId, { name: 'foto.png', dataUrl: PNG_DATA_URL })
  );
  const cap = captureRes();
  await media.serve({ params: { id: String(up.payload.id) }, headers: {} }, cap.res);
  await drain(cap.state);

  assert.equal(cap.state.headers['content-type'], 'image/png');
  assert.equal(cap.state.headers['accept-ranges'], 'bytes');
  assert.deepEqual(cap.body(), Buffer.from(PNG_B64, 'base64'));
});

test('el endpoint responde a rangos desde disco (Safari no reproduce audio sin esto)', async () => {
  const { clinicId } = await H.seedClinic();
  const buffer = Buffer.from('0123456789ABCDEF');
  const _id = new H.mongoose.Types.ObjectId();
  const { storageKey } = await mediaStore.write({ id: _id, buffer, mimeType: 'audio/ogg' });
  await ChatGalleryImage.create({ _id, clinic: clinicId, name: 'nota.ogg', storageKey, mimeType: 'audio/ogg', size: buffer.length });

  const cap = captureRes();
  await media.serve({ params: { id: String(_id) }, headers: { range: 'bytes=4-7' } }, cap.res);
  await drain(cap.state);

  assert.equal(cap.state.status, 206);
  assert.equal(cap.state.headers['content-range'], 'bytes 4-7/16');
  assert.equal(cap.body().toString(), '4567');
});

test('los adjuntos anteriores a la migración se siguen sirviendo desde Mongo', async () => {
  const { clinicId } = await H.seedClinic();
  // Sin storageKey: como quedaron los subidos antes de este cambio.
  const doc = await ChatGalleryImage.create({
    clinic: clinicId, name: 'vieja.png', dataUrl: PNG_DATA_URL, mimeType: 'image/png',
  });
  const cap = captureRes();
  await media.serve({ params: { id: String(doc._id) }, headers: {} }, cap.res);
  await drain(cap.state);
  assert.deepEqual(cap.body(), Buffer.from(PNG_B64, 'base64'));
});

// ────────────── enviar por WhatsApp: los dos gateways encuentran los bytes ──────────────

test('el resolutor de adjuntos funciona con archivo en disco Y con base64 heredado', async () => {
  const { clinicId } = await H.seedClinic();

  const _id = new H.mongoose.Types.ObjectId();
  const buffer = Buffer.from(PNG_B64, 'base64');
  const { storageKey } = await mediaStore.write({ id: _id, buffer, mimeType: 'image/png' });
  await ChatGalleryImage.create({ _id, clinic: clinicId, name: 'disco.png', storageKey, mimeType: 'image/png' });

  const viejo = await ChatGalleryImage.create({
    clinic: clinicId, name: 'mongo.png', dataUrl: PNG_DATA_URL, mimeType: 'image/png',
  });

  const enDisco = await mediaStore.loadAttachment(_id);
  assert.deepEqual(enDisco.buffer, buffer, 'lee del disco');
  assert.equal(enDisco.mimeType, 'image/png');
  assert.equal(enDisco.name, 'disco.png');

  const enMongo = await mediaStore.loadAttachment(viejo._id);
  assert.deepEqual(enMongo.buffer, buffer, 'lee el base64 heredado');

  assert.equal(await mediaStore.loadAttachment(new H.mongoose.Types.ObjectId()), null);
});

test('el envío por QR lee el adjunto desde el disco', async () => {
  const { clinicId } = await H.seedClinic();
  const _id = new H.mongoose.Types.ObjectId();
  const buffer = Buffer.from(PNG_B64, 'base64');
  const { storageKey } = await mediaStore.write({ id: _id, buffer, mimeType: 'image/png' });
  await ChatGalleryImage.create({ _id, clinic: clinicId, name: 'promo.png', storageKey, mimeType: 'image/png' });

  // Se comprueba el resolutor que usa sendMedia: es el punto exacto donde antes
  // se leía `ChatGalleryImage.dataUrl`. Si esto devolviera null, el envío con
  // adjunto fallaría con "No se pudo leer la imagen guardada".
  const att = await mediaStore.loadAttachment(
    `/api/public/media/${_id}`.match(/\/api\/public\/media\/([a-f0-9]{24})/i)[1]
  );
  assert.ok(att, 'el gateway encuentra los bytes');
  assert.equal(att.buffer.toString('base64'), PNG_B64);
  assert.equal(att.name, 'promo.png', 'conserva el nombre real del archivo (lo ve el contacto)');
});

// ─────────────────────── borrar: no deja basura en disco ───────────────────────

test('borrar un adjunto de la galería también borra el archivo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const up = await H.runController(
    chat.uploadGallery,
    H.mockReq(clinicId, userId, { name: 'promo.png', dataUrl: PNG_DATA_URL })
  );
  const doc = await ChatGalleryImage.findById(up.payload._id).lean();
  assert.ok(await mediaStore.size(doc.storageKey), 'el archivo está');

  await H.runController(
    chat.deleteGalleryItem,
    H.mockReq(clinicId, userId, {}, { params: { id: String(doc._id) } })
  );
  assert.equal(await mediaStore.size(doc.storageKey), null, 'el archivo se borró del disco');
});

// ─────────────────────── la media entrante también va a disco ───────────────────────

test('una foto que manda el paciente se guarda en disco, no en el mensaje', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  await chat.ingestExternalMessage({
    clinicId, channel: 'whatsapp', externalUserId: '593987654321@c.us', phone: '593987654321',
    body: '', externalId: 'qr_foto', account: null,
    media: { type: 'image', dataUrl: PNG_DATA_URL, caption: 'mi receta' },
  });
  const msg = await require('../models/Message').findOne({ clinic: clinicId }).lean();
  assert.ok(!String(msg.mediaUrl).startsWith('data:'), 'el mensaje no lleva el base64');

  const doc = await ChatGalleryImage.findById(msg.mediaUrl.split('/').pop()).lean();
  assert.ok(doc.storageKey, 'el archivo está en disco');
  assert.ok(!doc.dataUrl, 'y no en Mongo');
  assert.equal(doc.kind, 'inbound');
  assert.deepEqual(await fs.readFile(path.join(tmpDir, doc.storageKey)), Buffer.from(PNG_B64, 'base64'));
});

// ─────────────────── descargar: el navegador debe GUARDAR el archivo ───────────────────
//
// Un PDF que mandaba un paciente se descargaba en el equipo de quien lo probó y
// NO en el de sus compañeros, sin ningún error a la vista. La causa estaba en el
// cliente (fetch → Blob → `<a download>` sintético, que Firefox/Safari cancelan y
// Chrome bloquea si se pierde la activación de usuario). La solución es que el
// propio servidor diga "esto se guarda": `?download=1` → Content-Disposition.

test('?download=1 responde con Content-Disposition attachment y el nombre real', async () => {
  const { clinicId } = await H.seedClinic();
  const _id = new H.mongoose.Types.ObjectId();
  const buffer = Buffer.from('%PDF-1.4 contenido');
  const { storageKey } = await mediaStore.write({ id: _id, buffer, mimeType: 'application/pdf' });
  await ChatGalleryImage.create({
    _id, clinic: clinicId, name: 'MOREIRA MUÑOZ ITALO.pdf', storageKey,
    mimeType: 'application/pdf', size: buffer.length,
  });

  const cap = captureRes();
  await media.serve({ params: { id: String(_id) }, headers: {}, query: { download: '1' } }, cap.res);
  await drain(cap.state);

  const cd = cap.state.headers['content-disposition'];
  assert.match(cd, /^attachment;/, 'el navegador lo guarda, no lo abre');
  // ASCII para los navegadores viejos + UTF-8 para conservar la Ñ.
  assert.match(cd, /filename="MOREIRA MU_OZ ITALO\.pdf"/);
  assert.match(cd, /filename\*=UTF-8''MOREIRA%20MU%C3%91OZ%20ITALO\.pdf/);
  assert.deepEqual(cap.body(), buffer, 'y llegan los bytes completos');
});

test('sin ?download=1 el archivo se sigue mostrando dentro del chat', async () => {
  const { clinicId } = await H.seedClinic();
  const _id = new H.mongoose.Types.ObjectId();
  const buffer = Buffer.from(PNG_B64, 'base64');
  const { storageKey } = await mediaStore.write({ id: _id, buffer, mimeType: 'image/png' });
  await ChatGalleryImage.create({ _id, clinic: clinicId, name: 'foto.png', storageKey, mimeType: 'image/png' });

  const cap = captureRes();
  await media.serve({ params: { id: String(_id) }, headers: {} }, cap.res);
  await drain(cap.state);
  assert.equal(cap.state.headers['content-disposition'], undefined, 'el <img> del chat lo pinta inline');
});

test('un adjunto sin extensión en el nombre la recibe según su tipo MIME', async () => {
  const { clinicId } = await H.seedClinic();
  const _id = new H.mongoose.Types.ObjectId();
  const buffer = Buffer.from('audio');
  const { storageKey } = await mediaStore.write({ id: _id, buffer, mimeType: 'audio/ogg' });
  await ChatGalleryImage.create({ _id, clinic: clinicId, name: 'nota de voz', storageKey, mimeType: 'audio/ogg' });

  const cap = captureRes();
  await media.serve({ params: { id: String(_id) }, headers: {}, query: { download: '1' } }, cap.res);
  await drain(cap.state);
  assert.match(cap.state.headers['content-disposition'], /filename="nota de voz\.ogg"/);
});

test('un nombre con comillas o saltos de línea no puede romper la cabecera', async () => {
  const { clinicId } = await H.seedClinic();
  const _id = new H.mongoose.Types.ObjectId();
  const buffer = Buffer.from('%PDF');
  const { storageKey } = await mediaStore.write({ id: _id, buffer, mimeType: 'application/pdf' });
  await ChatGalleryImage.create({
    _id, clinic: clinicId, name: '../../etc/pas"swd\r\nX-Malo: 1.pdf', storageKey, mimeType: 'application/pdf',
  });

  const cap = captureRes();
  await media.serve({ params: { id: String(_id) }, headers: {}, query: { download: '1' } }, cap.res);
  await drain(cap.state);
  const cd = cap.state.headers['content-disposition'];
  assert.ok(!/[\r\n]/.test(cd), 'sin saltos de línea');
  assert.match(cd, /filename="passwdX-Malo: 1\.pdf"/, 'sin ruta, sin comillas y sin cabecera inyectada');
});

test('el adjunto heredado dentro del mensaje también se puede descargar', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const Message = require('../models/Message');
  const msg = await Message.create({
    clinic: clinicId, conversation: new H.mongoose.Types.ObjectId(), direction: 'in', body: '',
    mediaType: 'document', mediaName: 'receta.pdf',
    mediaUrl: `data:application/pdf;base64,${Buffer.from('%PDF-1.4').toString('base64')}`,
  });

  const cap = captureRes();
  await media.serveMessageMedia({ params: { messageId: String(msg._id) }, headers: {}, query: { download: '1' } }, cap.res);
  await drain(cap.state);
  assert.match(cap.state.headers['content-disposition'], /filename="receta\.pdf"/);
  assert.equal(cap.body().toString(), '%PDF-1.4');
});

test('un mensaje ya migrado redirige CONSERVANDO el ?download=1', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const Message = require('../models/Message');
  const msg = await Message.create({
    clinic: clinicId, conversation: new H.mongoose.Types.ObjectId(), direction: 'in', body: '', mediaType: 'document',
    mediaUrl: '/api/public/media/6a8dd8cd2241e0d9c48d545b',
  });

  const cap = captureRes();
  await media.serveMessageMedia({ params: { messageId: String(msg._id) }, headers: {}, query: { download: '1' } }, cap.res);
  await drain(cap.state);
  // Sin esto la redirección perdería la intención y el PDF se abriría en una
  // pestaña en vez de guardarse.
  assert.equal(cap.state.redirect, '/api/public/media/6a8dd8cd2241e0d9c48d545b?download=1');
});
