/**
 * El video H.265/HEVC no debe llegar nunca a Meta.
 *
 * Meta ACEPTA un MP4 con pista HEVC —contenedor válido, devuelve media id y
 * responde 200 al enviar— y solo lo rechaza DESPUÉS, al entregarlo, con el
 * estado `failed` y el código 131053 por webhook. Para el agente eso es un
 * mensaje que se pinta enviado y se vuelve rojo sin explicación.
 *
 * Hay dos defensas y aquí se prueban las dos:
 *   1. Al SUBIR: el archivo se convierte a H.264 (utils/videoTranscode).
 *   2. Al ENVIAR: si un video guardado ANTES de esa mejora sigue en HEVC, se
 *      corta con un error claro en vez de dejar que Meta lo acepte y lo tire.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const H = require('./_integrationHelpers');
const wa = require('../utils/whatsappCloud');
const vt = require('../utils/videoTranscode');
const { resolveFfmpegPath } = require('../utils/audioTranscode');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const mediaStore = require('../utils/mediaStore');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const creds = { accessToken: 'TOKEN', phoneNumberId: '123', apiVersion: 'v23.0' };
const ffmpeg = resolveFfmpegPath();
const basura = [];
test.after(() => basura.forEach((p) => fs.promises.unlink(p).catch(() => {})));

function generarHevc() {
  if (!ffmpeg) return null;
  const out = path.join(os.tmpdir(), `guard_${crypto.randomBytes(6).toString('hex')}.mp4`);
  basura.push(out);
  const r = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
    '-c:v', 'libx265', '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p', '-an', out,
  ]);
  return r.status === 0 && fs.existsSync(out) ? fs.readFileSync(out) : null;
}

test('un video HEVC ya guardado NO se manda a Meta: se corta con un error accionable', async (t) => {
  const bytes = generarHevc();
  if (!bytes) return t.skip('este ffmpeg no codifica HEVC');
  const { clinicId } = await H.seedClinic();

  const doc = await ChatGalleryImage.create({
    clinic: clinicId, name: 'ubicacion.mp4', mimeType: 'video/mp4', kind: 'attachment',
  });
  const escrito = await mediaStore.write({ id: doc._id, buffer: bytes, mimeType: 'video/mp4', when: new Date() });
  await ChatGalleryImage.updateOne({ _id: doc._id }, { storageKey: escrito.storageKey, size: bytes.length });

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push(String(url));
    if (String(url).endsWith('/media')) return { ok: true, json: async () => ({ id: 'MEDIA_ID_1' }) };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT1' }] }) };
  };
  try {
    const r = await wa.sendMedia(creds, '593999999999', `https://x/api/public/media/${doc._id}`, 'mira', 'video');
    assert.equal(r.ok, false, 'no debe darse por enviado');
    assert.equal(r.errorCode, 'video_codec_no_soportado');
    assert.match(r.error, /H\.265|HEVC/);
    assert.equal(calls.length, 0, 'ni siquiera se sube a Meta: se corta antes de gastar la subida');
  } finally {
    global.fetch = origFetch;
  }
});

test('un video H.264 sí se envía con normalidad (el guardia no da falsos positivos)', async (t) => {
  if (!ffmpeg) return t.skip('ffmpeg no disponible');
  const out = path.join(os.tmpdir(), `guard_ok_${crypto.randomBytes(6).toString('hex')}.mp4`);
  basura.push(out);
  const gen = spawnSync(ffmpeg, [
    '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-an', out,
  ]);
  if (gen.status !== 0) return t.skip('ffmpeg no pudo generar la muestra');
  const bytes = fs.readFileSync(out);
  const { clinicId } = await H.seedClinic();

  const doc = await ChatGalleryImage.create({
    clinic: clinicId, name: 'ok.mp4', mimeType: 'video/mp4', kind: 'attachment',
  });
  const escrito = await mediaStore.write({ id: doc._id, buffer: bytes, mimeType: 'video/mp4', when: new Date() });
  await ChatGalleryImage.updateOne({ _id: doc._id }, { storageKey: escrito.storageKey, size: bytes.length });

  const calls = [];
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    calls.push({ url: String(url), opts });
    if (String(url).endsWith('/media')) return { ok: true, json: async () => ({ id: 'MEDIA_ID_1' }) };
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.OUT1' }] }) };
  };
  try {
    const r = await wa.sendMedia(creds, '593999999999', `https://x/api/public/media/${doc._id}`, 'mira', 'video');
    assert.equal(r.ok, true, JSON.stringify(r));
    const body = JSON.parse(calls[1].opts.body);
    assert.equal(body.type, 'video');
    assert.equal(body.video.id, 'MEDIA_ID_1');
  } finally {
    global.fetch = origFetch;
  }
});

test('el guardia no bloquea imágenes ni documentos aunque lleven bytes raros', async () => {
  // looksLikeHevc solo se consulta para kind==='video'; una imagen no se toca.
  assert.equal(vt.looksLikeHevc(Buffer.from('....ftypheic....hvcC....', 'latin1')), true);
  const { clinicId } = await H.seedClinic();
  const img = await ChatGalleryImage.create({
    clinic: clinicId, name: 'foto.png',
    dataUrl: 'data:image/png;base64,iVBORw0KGgo=', mimeType: 'image/png',
  });
  const origFetch = global.fetch;
  global.fetch = async (url) => (String(url).endsWith('/media')
    ? { ok: true, json: async () => ({ id: 'M1' }) }
    : { ok: true, json: async () => ({ messages: [{ id: 'wamid.X' }] }) });
  try {
    const r = await wa.sendMedia(creds, '593999999999', `https://x/api/public/media/${img._id}`, '', 'image');
    assert.equal(r.ok, true, 'una imagen nunca pasa por el guardia de video');
  } finally {
    global.fetch = origFetch;
  }
});
