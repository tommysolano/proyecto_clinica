/**
 * Flujo end-to-end de imágenes de la landing de auto-agendamiento:
 *   subir → persistir en Mongo (ChatGalleryImage) → servir bytes públicamente,
 * y que la config guarde las URLs y el endpoint público las devuelva.
 *
 * Prueba contra los controllers reales y un Mongo en memoria (mismo harness que
 * los flujos contables).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const bookingConfig = require('../controllers/bookingConfigController');
const bookingPublic = require('../controllers/bookingPublicController');
const media = require('../controllers/mediaController');
const ChatGalleryImage = require('../models/ChatGalleryImage');

// PNG 1x1 transparente.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG_DATA_URL = `data:image/png;base64,${PNG_B64}`;

// res que captura headers + body (media.serve usa res.set / res.send con Buffer).
/**
 * `res` simulado. Es un Writable DE VERDAD porque el endpoint sirve los archivos
 * del disco por STREAM (`fs.createReadStream(...).pipe(res)`): un video de 15 MB
 * no puede cargarse en memoria por cada agente que lo abre. Un mock con solo
 * `send`/`json` hacía fallar el pipe y el endpoint devolvía 500.
 */
function captureRes() {
  const { Writable } = require('stream');
  const state = { statusCode: 200, headers: {}, body: undefined, done: false };
  const chunks = [];
  const res = new Writable({
    write(chunk, _enc, cb) { chunks.push(Buffer.from(chunk)); cb(); },
  });
  res.on('finish', () => { state.body = Buffer.concat(chunks); state.done = true; });
  res.status = (c) => { state.statusCode = c; return res; };
  res.set = (k, v) => {
    if (typeof k === 'object') Object.assign(state.headers, k);
    else state.headers[k] = v;
    return res;
  };
  res.send = (b) => {
    if (b !== undefined) chunks.push(Buffer.isBuffer(b) ? b : Buffer.from(String(b)));
    res.end();
    return res;
  };
  res.json = (b) => { state.body = b; state.done = true; return res; };
  return { res, state };
}

/** Espera a que el stream termine de volcar en el `res` simulado. */
async function drain(state, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until && !state.done) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 10));
  }
  return state;
}

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('subir imagen → se persiste en Mongo → se sirve con los bytes correctos', async () => {
  const { clinicId, userId } = await H.seedClinic();

  // 1) Subir.
  const up = await H.runController(
    bookingConfig.uploadImage,
    H.mockReq(clinicId, userId, { dataUrl: PNG_DATA_URL, name: 'portada.png' }),
  );
  assert.equal(up.statusCode, 201, JSON.stringify(up.payload));
  assert.ok(up.payload.id, 'devuelve id');
  assert.match(up.payload.url, /\/api\/public\/media\/[a-f0-9]{24}$/, 'url pública autoalojada');

  // 2) Persistencia: el registro queda en Mongo, pero los BYTES van al disco del
  //    servidor (ver utils/mediaStore). Guardarlos en base64 dentro de Mongo se
  //    comía el 88% de la base de datos.
  const stored = await ChatGalleryImage.findById(up.payload.id);
  assert.ok(stored, 'el registro se guardó en Mongo');
  assert.ok(stored.storageKey, 'apunta al archivo en disco');
  assert.ok(!stored.dataUrl, 'NO guarda el base64 dentro de Mongo');
  assert.equal(String(stored.clinic), String(clinicId), 'queda asociada a la clínica');
  assert.equal(stored.mimeType, 'image/png');
  const onDisk = await require('../utils/mediaStore').read(stored.storageKey);
  assert.deepEqual(onDisk, Buffer.from(PNG_B64, 'base64'), 'el archivo está íntegro en disco');

  // 3) Servir: el endpoint público devuelve los bytes decodificados (sin auth).
  const { res, state } = captureRes();
  await media.serve({ params: { id: up.payload.id }, headers: {} }, res);
  await drain(state);
  assert.equal(state.statusCode, 200);
  assert.equal(state.headers['Content-Type'], 'image/png');
  assert.ok(Buffer.isBuffer(state.body), 'responde un Buffer');
  assert.deepEqual(state.body, Buffer.from(PNG_B64, 'base64'), 'bytes coinciden con el original');
});

// ─────────────────────────────────────────────────────────────────────────────
test('las imágenes persisten en la config y el endpoint público las devuelve', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const cover = await H.runController(bookingConfig.uploadImage, H.mockReq(clinicId, userId, { dataUrl: PNG_DATA_URL }));
  const gal = await H.runController(bookingConfig.uploadImage, H.mockReq(clinicId, userId, { dataUrl: PNG_DATA_URL }));
  const prog = await H.makeProduct(clinicId, { category: 'programa', name: 'Programa Detox', salePrice: 120 });

  // Guardar la config con todo el contenido de la landing.
  const saved = await H.runController(bookingConfig.update, H.mockReq(clinicId, userId, {
    enabled: true,
    coverImageUrl: cover.payload.url,
    gallery: [gal.payload.url],
    about: 'Shiluv es una clínica integrativa.',
    highlights: ['Atención personalizada'],
    programs: [{ product: prog._id, name: 'Programa Detox', description: 'Desintoxicación', imageUrl: gal.payload.url, priceLabel: '$120', durationMinutes: 90 }],
  }));
  assert.equal(saved.statusCode, 200, JSON.stringify(saved.payload));
  const token = saved.payload.token;
  assert.ok(token, 'la config tiene token público');

  // Releer desde Mongo: persiste tras "reinicio" (nueva consulta).
  const BookingConfig = require('../models/BookingConfig');
  const fresh = await BookingConfig.findOne({ clinic: clinicId });
  assert.equal(fresh.coverImageUrl, cover.payload.url);
  assert.equal(fresh.gallery.length, 1);
  assert.equal(fresh.programs.length, 1);

  // El endpoint público (lo que ve el paciente) devuelve las URLs.
  const info = await H.runController(bookingPublic.info, H.mockReq(clinicId, userId, {}, { params: { token } }));
  assert.equal(info.statusCode, 200, JSON.stringify(info.payload));
  assert.equal(info.payload.coverImageUrl, cover.payload.url);
  assert.deepEqual(info.payload.gallery, [gal.payload.url]);
  assert.equal(info.payload.programs.length, 1);
  assert.equal(info.payload.programs[0].name, 'Programa Detox');
  assert.equal(info.payload.about, 'Shiluv es una clínica integrativa.');
});

// ─────────────────────────────────────────────────────────────────────────────
test('rechaza dataUrl inválido y demasiado grande', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const bad = await H.runController(bookingConfig.uploadImage, H.mockReq(clinicId, userId, { dataUrl: 'no-soy-una-imagen' }));
  assert.equal(bad.statusCode, 400);

  const huge = 'data:image/png;base64,' + 'A'.repeat(2_600_000);
  const big = await H.runController(bookingConfig.uploadImage, H.mockReq(clinicId, userId, { dataUrl: huge }));
  assert.equal(big.statusCode, 400);
  assert.match(big.payload.message, /grande/i);
});
