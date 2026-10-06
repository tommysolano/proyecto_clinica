/**
 * LA DURACIÓN DE LAS NOTAS DE VOZ (oct-2026).
 *
 * «Un audio de unos segundos dice que dura mucho más». Dos causas, las dos aquí:
 *   1. el servidor respondía `Range: bytes=-N` (los ÚLTIMOS N bytes) con los
 *      PRIMEROS: Safari/iPhone lee el final del ogg para saber cuánto dura y
 *      recibía la cabecera;
 *   2. los audios RECIBIDOS no traían duración medida, así que la burbuja
 *      dependía de ese cálculo del navegador. Ahora el almacén la mide con
 *      ffmpeg al guardar cualquier audio.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const H = require('./_integrationHelpers');

const media = require('../controllers/mediaController');
const chatMedia = require('../utils/chatMedia');
const { resolveFfmpegPath } = require('../utils/audioTranscode');

let tmpDir;

test.before(async () => {
  await H.startDb();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'shiluv-audio-'));
  process.env.MEDIA_DIR = tmpDir;
});
test.after(async () => {
  await H.stopDb();
  delete process.env.MEDIA_DIR;
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

/** Nota de voz real: 3 s de tono en ogg/opus, como las de WhatsApp. */
async function notaDeVoz(segundos) {
  const ffmpeg = resolveFfmpegPath();
  const out = path.join(tmpDir, `tono_${segundos}.ogg`);
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${segundos}`,
    '-ac', '1', '-c:a', 'libopus', '-b:a', '16k', '-f', 'ogg', out,
  ]);
  assert.equal(r.status, 0, String(r.stderr));
  return fs.readFile(out);
}

test('Range: los tres formatos, incluido el sufijo «los últimos N bytes»', () => {
  const r = media._rangoPedido;
  assert.deepEqual(r('bytes=-100', 4102), { start: 4002, end: 4101 }, 'el sufijo es el FINAL del archivo');
  assert.deepEqual(r('bytes=-9999', 4102), { start: 0, end: 4101 }, 'un sufijo mayor que el archivo es el archivo entero');
  assert.deepEqual(r('bytes=0-99', 4102), { start: 0, end: 99 });
  assert.deepEqual(r('bytes=4000-', 4102), { start: 4000, end: 4101 });
  assert.equal(r('bytes=5000-', 4102), 'invalid');
  assert.equal(r('bytes=-0', 4102), 'invalid');
  assert.equal(r(undefined, 4102), null);
});

test('al guardar un audio se mide su duración real', async () => {
  const buffer = await notaDeVoz(3);
  const stored = await chatMedia.storeBufferMedia({
    clinicId: new H.mongoose.Types.ObjectId(), buffer, mimeType: 'audio/ogg; codecs=opus', name: 'nota.ogg',
  });
  assert.ok(stored.duration >= 2.9 && stored.duration <= 3.2, `duración medida: ${stored.duration}`);

  // Una imagen no lleva duración.
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const img = await chatMedia.storeBufferMedia({ clinicId: new H.mongoose.Types.ObjectId(), buffer: png, mimeType: 'image/png' });
  assert.equal(img.duration, undefined);
});

test('el endpoint público sirve el FINAL del audio cuando se le pide', async () => {
  const buffer = await notaDeVoz(2);
  const stored = await chatMedia.storeBufferMedia({
    clinicId: new H.mongoose.Types.ObjectId(), buffer, mimeType: 'audio/ogg', name: 'nota.ogg',
  });
  const res = await new Promise((resolve) => {
    const { PassThrough } = require('stream');
    const out = new PassThrough();
    const chunks = [];
    out.on('data', (c) => chunks.push(c));
    out.on('end', () => resolve({ headers: out.headers, status: out.statusCode, body: Buffer.concat(chunks) }));
    out.headers = {};
    out.statusCode = 200;
    out.set = (k, v) => { out.headers[k.toLowerCase()] = v; return out; };
    out.status = (c) => { out.statusCode = c; return out; };
    out.send = (b) => { out.end(b); return out; };
    media.serve({ params: { id: String(stored.id) }, headers: { range: 'bytes=-64' }, query: {} }, out);
  });
  assert.equal(res.status, 206);
  assert.equal(res.headers['content-range'], `bytes ${buffer.length - 64}-${buffer.length - 1}/${buffer.length}`);
  assert.deepEqual(res.body, buffer.subarray(buffer.length - 64), 'son los últimos bytes, no la cabecera');
});
