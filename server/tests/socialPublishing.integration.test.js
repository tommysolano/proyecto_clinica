/**
 * Planificador de redes sociales (Fénix → Redes sociales).
 *
 * Se simula la Graph API de Meta con un fetch falso y se comprueba el ciclo
 * completo: programar → el job publica → estado por destino, el reclamo
 * atómico (dos ticks a la vez no publican dos veces), los reintentos ante
 * errores momentáneos, el modo «publicar a mano» y las validaciones por red.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.PUBLIC_API_URL = 'https://app.test/api';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const { startDb, stopDb, resetDb, mockReq, runController, mongoose } = require('./_integrationHelpers');
const SocialPost = require('../models/SocialPost');
const SocialAccount = require('../models/SocialAccount');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const Notification = require('../models/Notification');
const ctrl = require('../controllers/socialController');
const { processDueSocialPosts } = require('../utils/social/publisher');
const { composeText, normalizeHashtags, validateTarget } = require('../utils/social/rules');
const { chunkPlan } = require('../utils/social/tiktok');
const oauth = require('../utils/social/oauth');

const realFetch = global.fetch;
let calls = [];
let handler = null;

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Map(),
    text: async () => JSON.stringify(body),
  };
}

before(async () => {
  await startDb();
  global.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const form = opts.body ? Object.fromEntries(new URLSearchParams(String(opts.body))) : {};
    const call = { path: u.pathname, method: opts.method || 'GET', form, query: Object.fromEntries(u.searchParams) };
    calls.push(call);
    // Un poco de latencia: es lo que deja a dos ticks pisarse si no hubiera reclamo.
    await new Promise((r) => setTimeout(r, 5));
    const r = handler(call);
    return jsonResponse(r.status || 200, r.body);
  };
});

after(async () => {
  global.fetch = realFetch;
  await stopDb();
});

beforeEach(async () => {
  await resetDb();
  calls = [];
  handler = () => ({ body: {} });
});

const past = () => new Date(Date.now() - 60 * 1000);

async function seed() {
  const clinicId = new mongoose.Types.ObjectId();
  const userId = new mongoose.Types.ObjectId();
  const ig = await SocialAccount.create({
    clinic: clinicId, network: 'instagram', externalId: 'IG1', name: 'Shiluv', username: 'shiluv', pageId: 'PAGE1', accessToken: 'tok-page',
  });
  const fb = await SocialAccount.create({ clinic: clinicId, network: 'facebook', externalId: 'PAGE1', name: 'Shiluv FB', accessToken: 'tok-page' });
  const img = await ChatGalleryImage.create({ clinic: clinicId, name: 'foto.jpg', storageKey: '2026/10/x.jpg', mimeType: 'image/jpeg', kind: 'social' });
  return { clinicId, userId, ig, fb, img };
}

function mediaOf(img) {
  return { media: img._id, mimeType: img.mimeType, name: img.name, width: 1080, height: 1080 };
}

/** Graph API falsa para una imagen de Instagram que sale sin problemas. */
function igHappy(call) {
  if (call.path.endsWith('/IG1/media')) return { body: { id: 'CONT1' } };
  if (call.path.endsWith('/CONT1')) return { body: { status_code: 'FINISHED' } };
  if (call.path.endsWith('/IG1/media_publish')) return { body: { id: 'MEDIA1' } };
  if (call.path.endsWith('/MEDIA1')) return { body: { permalink: 'https://instagram.com/p/abc' } };
  if (call.path.endsWith('/MEDIA1/comments')) return { body: { id: 'C1' } };
  return { status: 404, body: { error: { message: `inesperado ${call.path}`, code: 100, fbtrace_id: 'x' } } };
}

test('el job publica una imagen en Instagram, con texto, hashtags y primer comentario', async () => {
  const { clinicId, userId, ig, img } = await seed();
  handler = igHappy;
  const post = await SocialPost.create({
    clinic: clinicId, title: 'Promo', caption: 'Ven a conocernos', hashtags: ['salud', '#Bienestar'], link: 'https://shiluv.ec',
    firstComment: 'Agenda por WhatsApp', media: [mediaOf(img)], status: 'scheduled', scheduledAt: past(), createdBy: userId,
    targets: [{ network: 'instagram', account: ig._id, format: 'post' }],
  });

  assert.equal(await processDueSocialPosts(), 1);

  const saved = await SocialPost.findById(post._id).lean();
  assert.equal(saved.status, 'published');
  assert.equal(saved.targets[0].status, 'published');
  assert.equal(saved.targets[0].externalId, 'MEDIA1');
  assert.equal(saved.targets[0].permalink, 'https://instagram.com/p/abc');
  assert.equal(saved.targets[0].commentStatus, 'ok');
  assert.ok(saved.publishedAt);

  const create = calls.find((c) => c.path.endsWith('/IG1/media'));
  assert.equal(create.form.image_url, `https://app.test/api/public/media/${img._id}`);
  assert.equal(create.form.caption, 'Ven a conocernos\n\nhttps://shiluv.ec\n\n#salud #Bienestar');
  assert.equal(create.form.access_token, 'tok-page');
  assert.equal(calls.filter((c) => c.path.endsWith('/media_publish')).length, 1);
});

test('dos ticks a la vez publican UNA sola vez (reclamo atómico)', async () => {
  const { clinicId, userId, ig, img } = await seed();
  handler = igHappy;
  await SocialPost.create({
    clinic: clinicId, title: 'Doble', media: [mediaOf(img)], status: 'scheduled', scheduledAt: past(), createdBy: userId,
    targets: [{ network: 'instagram', account: ig._id, format: 'post' }],
  });
  const [a, b] = await Promise.all([processDueSocialPosts(), processDueSocialPosts()]);
  assert.equal(a + b, 1);
  assert.equal(calls.filter((c) => c.path.endsWith('/media_publish')).length, 1);
});

test('el video de Instagram queda procesándose y sale en la siguiente vuelta', async () => {
  const { clinicId, userId, ig } = await seed();
  const vid = await ChatGalleryImage.create({ clinic: clinicId, name: 'v.mp4', storageKey: '2026/10/v.mp4', mimeType: 'video/mp4', kind: 'social' });
  let ready = false;
  handler = (call) => {
    if (call.path.endsWith('/IG1/media')) return { body: { id: 'CONTV' } };
    if (call.path.endsWith('/CONTV')) return { body: { status_code: ready ? 'FINISHED' : 'IN_PROGRESS' } };
    if (call.path.endsWith('/IG1/media_publish')) return { body: { id: 'MV' } };
    if (call.path.endsWith('/MV')) return { body: { permalink: 'https://instagram.com/reel/v' } };
    return { status: 404, body: { error: { message: 'x', code: 100, fbtrace_id: 'x' } } };
  };
  const post = await SocialPost.create({
    clinic: clinicId, title: 'Reel', media: [{ media: vid._id, mimeType: 'video/mp4', duration: 20 }], status: 'scheduled', scheduledAt: past(),
    createdBy: userId, targets: [{ network: 'instagram', account: ig._id, format: 'reel', options: { shareToFeed: false } }],
  });
  await processDueSocialPosts();
  let saved = await SocialPost.findById(post._id);
  assert.equal(saved.status, 'publishing');
  assert.equal(saved.targets[0].status, 'processing');
  assert.equal(calls.find((c) => c.path.endsWith('/IG1/media')).form.media_type, 'REELS');
  assert.equal(calls.find((c) => c.path.endsWith('/IG1/media')).form.share_to_feed, 'false');

  // Llega la hora de volver a mirar.
  ready = true;
  saved.nextRunAt = past();
  saved.targets[0].nextCheckAt = past();
  await saved.save();
  await processDueSocialPosts();
  saved = await SocialPost.findById(post._id).lean();
  assert.equal(saved.status, 'published');
  assert.equal(saved.targets[0].permalink, 'https://instagram.com/reel/v');
});

test('Facebook: un post de solo texto manda el enlace aparte; si una red falla queda «parcial»', async () => {
  const { clinicId, userId, fb, ig } = await seed();
  handler = (call) => {
    if (call.path.endsWith('/PAGE1/feed')) return { body: { id: 'PAGE1_99' } };
    if (call.path.endsWith('/PAGE1_99')) return { body: { permalink_url: 'https://facebook.com/PAGE1/posts/99' } };
    return { status: 400, body: { error: { message: 'Permiso denegado', code: 10, fbtrace_id: 'x' } } };
  };
  const post = await SocialPost.create({
    clinic: clinicId, title: 'Aviso', caption: 'Feriado: atendemos normal', link: 'https://shiluv.ec', status: 'scheduled', scheduledAt: past(),
    createdBy: userId,
    targets: [
      { network: 'facebook', account: fb._id, format: 'post' },
      // Sin medios: Instagram no lo acepta → falla en la validación previa.
      { network: 'instagram', account: ig._id, format: 'post' },
    ],
  });
  await processDueSocialPosts();
  const saved = await SocialPost.findById(post._id).lean();
  const feed = calls.find((c) => c.path.endsWith('/PAGE1/feed'));
  assert.equal(feed.form.message, 'Feriado: atendemos normal');
  assert.equal(feed.form.link, 'https://shiluv.ec');
  assert.equal(saved.targets[0].status, 'published');
  assert.equal(saved.targets[1].status, 'failed');
  assert.match(saved.targets[1].error, /exactamente 1 imagen/);
  assert.equal(saved.status, 'partial');
  // Se avisa del fallo a quien la creó.
  assert.equal(await Notification.countDocuments({ type: 'social_post_failed', user: userId }), 1);
});

test('error momentáneo de Meta: se reintenta más tarde; error definitivo: falla', async () => {
  const { clinicId, userId, fb } = await seed();
  handler = () => ({ status: 500, body: { error: { message: 'Servicio no disponible', code: 2, is_transient: true, fbtrace_id: 'x' } } });
  const post = await SocialPost.create({
    clinic: clinicId, title: 'Reintento', caption: 'Hola', status: 'scheduled', scheduledAt: past(), createdBy: userId,
    targets: [{ network: 'facebook', account: fb._id, format: 'post' }],
  });
  await processDueSocialPosts();
  let saved = await SocialPost.findById(post._id);
  assert.equal(saved.status, 'publishing');
  assert.equal(saved.targets[0].status, 'pending');
  assert.equal(saved.targets[0].attempts, 1);
  assert.ok(saved.targets[0].nextCheckAt > new Date());
  assert.match(saved.targets[0].error, /Reintentando/);

  // Token caducado (190): no se reintenta y la cuenta queda marcada.
  handler = () => ({ status: 400, body: { error: { message: 'Token caducado', code: 190, type: 'OAuthException', fbtrace_id: 'x' } } });
  saved.nextRunAt = past();
  saved.targets[0].nextCheckAt = past();
  await saved.save();
  await processDueSocialPosts();
  saved = await SocialPost.findById(post._id).lean();
  assert.equal(saved.status, 'failed');
  assert.equal(saved.targets[0].status, 'failed');
  assert.equal((await SocialAccount.findById(fb._id).lean()).status, 'error');
});

test('modo manual: al llegar la hora avisa al responsable y se marca publicado a mano', async () => {
  const { clinicId, userId } = await seed();
  const post = await SocialPost.create({
    clinic: clinicId, title: 'Historia con link', status: 'scheduled', scheduledAt: past(), createdBy: userId, assignedTo: userId,
    targets: [{ network: 'instagram', format: 'story', mode: 'manual' }],
  });
  await processDueSocialPosts();
  let saved = await SocialPost.findById(post._id).lean();
  assert.equal(saved.status, 'needs_action');
  assert.equal(saved.targets[0].status, 'manual_due');
  assert.equal(calls.length, 0, 'un destino manual no llama a la API');
  assert.equal(await Notification.countDocuments({ type: 'social_post_manual', user: userId }), 1);

  const r = await runController(
    ctrl.markTargetManual,
    mockReq(clinicId, userId, { permalink: 'https://instagram.com/stories/x' }, { params: { id: post._id, targetId: saved.targets[0]._id } })
  );
  assert.equal(r.statusCode, 200);
  saved = await SocialPost.findById(post._id).lean();
  assert.equal(saved.status, 'published');
  assert.equal(saved.targets[0].permalink, 'https://instagram.com/stories/x');
});

test('programar valida cada red antes de guardar (Instagram solo JPG, TikTok exige elegir privacidad)', async () => {
  const { clinicId, userId, ig } = await seed();
  const png = await ChatGalleryImage.create({ clinic: clinicId, name: 'p.png', storageKey: '2026/10/p.png', mimeType: 'image/png', kind: 'social' });
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const r = await runController(
    ctrl.createPost,
    mockReq(clinicId, userId, {
      title: 'PNG', action: 'schedule', scheduledAt: future,
      media: [{ media: png._id, mimeType: 'image/png' }],
      targets: [{ network: 'instagram', account: ig._id, format: 'post' }],
    })
  );
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /JPG/);
  assert.equal(await SocialPost.countDocuments(), 0);

  // Como borrador sí se guarda (se corrige después).
  const d = await runController(
    ctrl.createPost,
    mockReq(clinicId, userId, { title: 'PNG', action: 'draft', media: [{ media: png._id, mimeType: 'image/png' }], targets: [{ network: 'instagram', account: ig._id, format: 'post' }] })
  );
  assert.equal(d.statusCode, 201);
  assert.equal(d.payload.status, 'draft');

  const tt = validateTarget(
    { title: 'x', media: [{ mimeType: 'video/mp4' }] },
    { network: 'tiktok', format: 'video', options: {} },
    { network: 'tiktok' }
  );
  assert.ok(tt.some((e) => /quién puede verlo/.test(e)));
});

test('con aprobación activa, lo que programa marketing queda en revisión hasta que un admin aprueba', async () => {
  const { clinicId, userId, fb } = await seed();
  const SocialPublishingConfig = require('../models/SocialPublishingConfig');
  await SocialPublishingConfig.create({ clinic: clinicId, requireApproval: true });
  const future = new Date(Date.now() + 3600 * 1000).toISOString();
  const r = await runController(
    ctrl.createPost,
    mockReq(clinicId, userId, { title: 'Revisar', caption: 'Hola', action: 'schedule', scheduledAt: future, targets: [{ network: 'facebook', account: fb._id, format: 'post' }] }, { role: 'marketing' })
  );
  assert.equal(r.statusCode, 201);
  assert.equal(r.payload.status, 'in_review');

  const a = await runController(ctrl.approvePost, mockReq(clinicId, new mongoose.Types.ObjectId(), {}, { params: { id: r.payload._id } }));
  assert.equal(a.statusCode, 200);
  assert.equal(a.payload.status, 'scheduled');
  // La respuesta lo trae poblado (y este usuario de prueba no existe): se mira en la base.
  assert.ok((await SocialPost.findById(r.payload._id).lean()).approvedBy);
});

test('reglas de texto, tramos de TikTok y state de OAuth', () => {
  assert.deepEqual(normalizeHashtags(['salud', '#Salud', 'vida sana', '##ok!']), ['#salud', '#vidasana', '#ok']);
  assert.equal(
    composeText({ caption: 'Base', link: 'https://x.ec', hashtags: ['a'] }, { caption: 'Propio' }),
    'Propio\n\nhttps://x.ec\n\n#a'
  );
  assert.deepEqual(chunkPlan(3 * 1024 * 1024), { chunkSize: 3 * 1024 * 1024, count: 1 });
  const big = 150 * 1024 * 1024;
  const plan = chunkPlan(big);
  assert.equal(plan.chunkSize, 10 * 1024 * 1024);
  assert.equal(plan.count, 15);
  // El último tramo absorbe el resto y no pasa de 128 MB.
  assert.ok(big - plan.chunkSize * (plan.count - 1) <= 128 * 1024 * 1024);

  const state = oauth.signState({ userId: 'u1', clinicId: 'c1', network: 'tiktok' });
  assert.equal(oauth.verifyState(state, 'tiktok').c, 'c1');
  assert.equal(oauth.verifyState(state, 'youtube'), null);
  assert.equal(oauth.redirectUri('meta'), 'https://app.test/api/social/oauth/meta/callback');
});
