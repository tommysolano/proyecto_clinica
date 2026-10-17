/**
 * Música y hora con segundos en el planificador de redes (oct-2026).
 *
 * - «Mi propio audio»: el servidor monta el audio en el video (o arma un video
 *   desde una imagen) con ffmpeg REAL, y devuelve un medio nuevo que conserva el
 *   original para poder quitar la música.
 * - «Canción de la app»: ninguna API la permite → solo destinos a mano (o
 *   borrador de TikTok), y el aviso dice qué canción poner.
 * - La hora lleva segundos: no sale antes de su segundo.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.PUBLIC_API_URL = 'https://app.test/api';

const H = require('./_integrationHelpers');
const SocialPost = require('../models/SocialPost');
const SocialAccount = require('../models/SocialAccount');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const Notification = require('../models/Notification');
const mediaStore = require('../utils/mediaStore');
const ctrl = require('../controllers/socialController');
const { processDueSocialPosts } = require('../utils/social/publisher');
const { resolveFfmpegPath } = require('../utils/audioTranscode');

const FFMPEG = resolveFfmpegPath();
let tmp;

before(async () => {
  await H.startDb();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'social-musica-'));
});
after(async () => {
  await H.stopDb();
  fs.rmSync(tmp, { recursive: true, force: true });
});
beforeEach(() => H.resetDb());

/** Genera un archivo con ffmpeg y lo guarda como medio 'social'. */
async function medio(clinicId, args, mimeType, nombre) {
  const out = path.join(tmp, nombre);
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args, out]);
  assert.equal(r.status, 0, String(r.stderr));
  const _id = new H.mongoose.Types.ObjectId();
  const { storageKey } = await mediaStore.write({ id: _id, buffer: fs.readFileSync(out), mimeType });
  return ChatGalleryImage.create({ _id, clinic: clinicId, name: nombre, storageKey, mimeType, size: fs.statSync(out).size, kind: 'social' });
}

test('pone la música en un video (sin perder el original) y arma un video desde una imagen', { skip: !FFMPEG }, async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const userId = new H.mongoose.Types.ObjectId();
  const video = await medio(clinicId, ['-f', 'lavfi', '-i', 'testsrc=size=320x568:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=300', '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'], 'video/mp4', 'v.mp4');
  const audio = await medio(clinicId, ['-f', 'lavfi', '-i', 'sine=frequency=800', '-t', '2', '-c:a', 'libmp3lame'], 'audio/mpeg', 'cancion.mp3');
  const foto = await medio(clinicId, ['-f', 'lavfi', '-i', 'color=c=blue:s=400x400', '-frames:v', '1'], 'image/jpeg', 'foto.jpg');

  const r = await H.runController(ctrl.mixMusic, H.mockReq(clinicId, userId, { base: video._id, audio: audio._id, mode: 'mix', volume: 0.7 }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.mimeType, 'video/mp4');
  assert.equal(r.payload.duration, 4, 'dura lo que el video (la música de 2 s se repite)');
  assert.equal(String(r.payload.original), String(video._id), 'se conserva el original para poder quitar la música');
  assert.equal(r.payload.musicName, 'cancion.mp3');
  const nuevo = await ChatGalleryImage.findById(r.payload.media).lean();
  assert.equal(nuevo.kind, 'social');
  assert.ok(await mediaStore.size(nuevo.storageKey) > 0);

  const r2 = await H.runController(ctrl.mixMusic, H.mockReq(clinicId, userId, { base: foto._id, audio: audio._id, seconds: 6, format: 'vertical' }));
  assert.equal(r2.statusCode, 201, JSON.stringify(r2.payload));
  assert.equal(r2.payload.duration, 6);
  assert.deepEqual([r2.payload.width, r2.payload.height], [1080, 1920], 'video vertical para historias y reels');

  // El audio tiene que ser un audio.
  const r3 = await H.runController(ctrl.mixMusic, H.mockReq(clinicId, userId, { base: video._id, audio: foto._id }));
  assert.equal(r3.statusCode, 400);
});

test('«canción de la app»: no se programa en automático; a mano sí, y el aviso dice qué canción poner', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const userId = new H.mongoose.Types.ObjectId();
  const ig = await SocialAccount.create({ clinic: clinicId, network: 'instagram', externalId: 'IG1', accessToken: 't' });
  const img = await ChatGalleryImage.create({ clinic: clinicId, name: 'f.jpg', storageKey: 'x.jpg', mimeType: 'image/jpeg', size: 10, kind: 'social' });
  const futuro = new Date(Date.now() + 3600e3).toISOString();
  const base = {
    title: 'Historia con canción', action: 'schedule', scheduledAt: futuro,
    music: { mode: 'app', name: 'Flowers — Miley Cyrus' },
    media: [{ media: img._id, mimeType: 'image/jpeg', size: 10 }],
  };

  const auto = await H.runController(ctrl.createPost, H.mockReq(clinicId, userId, { ...base, targets: [{ network: 'instagram', account: ig._id, format: 'story' }] }));
  assert.equal(auto.statusCode, 400);
  assert.match(auto.payload.message, /música de la app/);

  const manual = await H.runController(ctrl.createPost, H.mockReq(clinicId, userId, { ...base, targets: [{ network: 'instagram', account: ig._id, format: 'story', mode: 'manual' }] }));
  assert.equal(manual.statusCode, 201, JSON.stringify(manual.payload));
  assert.deepEqual(manual.payload.music, { mode: 'app', name: 'Flowers — Miley Cyrus' });

  await SocialPost.updateOne({ _id: manual.payload._id }, { scheduledAt: new Date(Date.now() - 1000) });
  await processDueSocialPosts();
  const aviso = await Notification.findOne({ type: 'social_post_manual' }).lean();
  assert.match(aviso.body, /Música: Flowers — Miley Cyrus/);
});

test('la hora lleva segundos: no sale antes de su segundo', async () => {
  const clinicId = new H.mongoose.Types.ObjectId();
  const userId = new H.mongoose.Types.ObjectId();
  const enDos = new Date(Date.now() + 2000);
  const r = await H.runController(ctrl.createPost, H.mockReq(clinicId, userId, {
    title: 'Al segundo', action: 'schedule', scheduledAt: enDos.toISOString(),
    targets: [{ network: 'facebook', format: 'post', mode: 'manual' }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(new Date(r.payload.scheduledAt).getTime(), enDos.getTime(), 'se guarda con sus segundos (y milisegundos)');

  assert.equal(await processDueSocialPosts(), 0, 'todavía no es la hora');
  await new Promise((res) => setTimeout(res, 2100));
  assert.equal(await processDueSocialPosts(), 1);
  assert.equal((await SocialPost.findById(r.payload._id).lean()).status, 'needs_action');
});
