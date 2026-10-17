/**
 * Conexiones con las redes (Fénix → Redes sociales): que cada OAuth y cada
 * publicación mande EXACTAMENTE lo que pide la documentación oficial de cada
 * red (oct-2026). Se simula la red con un fetch falso que anota cada petición,
 * y la subida de archivos (TikTok, YouTube) se intercepta en http.uploadFileRange.
 */
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.PUBLIC_API_URL = 'https://app.test/api';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';

const H = require('./_integrationHelpers');
const SocialPost = require('../models/SocialPost');
const SocialAccount = require('../models/SocialAccount');
const SocialPublishingConfig = require('../models/SocialPublishingConfig');
const ChatGalleryImage = require('../models/ChatGalleryImage');
const mediaStore = require('../utils/mediaStore');
const ctrl = require('../controllers/socialController');
const http = require('../utils/social/http');
const oauth = require('../utils/social/oauth');
const { processDueSocialPosts } = require('../utils/social/publisher');

const realFetch = global.fetch;
const realUpload = http.uploadFileRange;
let calls = [];
let uploads = [];
let route = null;

function respuesta(status, body, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: new Map(Object.entries(headers)), text: async () => JSON.stringify(body) };
}

before(async () => {
  await H.startDb();
  global.fetch = async (url, opts = {}) => {
    const u = new URL(String(url));
    const isJson = /json/.test(String(opts.headers?.['Content-Type'] || ''));
    const body = opts.body ? (isJson ? JSON.parse(opts.body) : Object.fromEntries(new URLSearchParams(String(opts.body)))) : {};
    const call = { host: u.host, path: u.pathname, query: Object.fromEntries(u.searchParams), method: opts.method || 'GET', headers: opts.headers || {}, body };
    calls.push(call);
    const r = route(call) || { status: 404, body: { error: { message: `inesperado ${u.host}${u.pathname}`, code: 100, fbtrace_id: 'x' } } };
    return respuesta(r.status || 200, r.body, r.headers);
  };
  http.uploadFileRange = async (url, opts) => {
    uploads.push({ url, ...opts });
    return url.includes('googleapis') && !url.includes('thumbnails') ? { status: 200, data: { id: 'VID1' } } : { status: 201, data: {} };
  };
});
after(async () => {
  global.fetch = realFetch;
  http.uploadFileRange = realUpload;
  await H.stopDb();
});
beforeEach(async () => {
  await H.resetDb();
  calls = [];
  uploads = [];
  route = () => null;
});

const past = () => new Date(Date.now() - 60 * 1000);
const ids = () => ({ clinicId: new H.mongoose.Types.ObjectId(), userId: new H.mongoose.Types.ObjectId() });

/** Callback de OAuth: responde HTML, no JSON. */
async function callback(network, query) {
  const { res, state } = H.mockRes();
  res.type = () => res;
  await ctrl.oauthCallback({ params: { network }, query }, res);
  return state;
}

async function videoEnDisco(clinicId, bytes = 1000) {
  const _id = new H.mongoose.Types.ObjectId();
  const { storageKey } = await mediaStore.write({ id: _id, buffer: Buffer.alloc(bytes, 1), mimeType: 'video/mp4' });
  return ChatGalleryImage.create({ _id, clinic: clinicId, name: 'v.mp4', storageKey, mimeType: 'video/mp4', size: bytes, kind: 'social' });
}

// ───────────────────────────── Meta ─────────────────────────────

test('Meta: OAuth pide los permisos completos, cambia el código por token largo y agrega Página + Instagram', async () => {
  const { clinicId, userId } = ids();
  await SocialPublishingConfig.create({ clinic: clinicId, meta: { appId: 'APP', appSecret: 'SECRET' } });

  const r = await H.runController(ctrl.oauthUrl, H.mockReq(clinicId, userId, {}, { params: { network: 'meta' } }));
  const url = new URL(r.payload.url);
  assert.equal(url.host, 'www.facebook.com');
  assert.match(url.pathname, /^\/v25\.0\/dialog\/oauth$/);
  assert.equal(url.searchParams.get('redirect_uri'), 'https://app.test/api/social/oauth/meta/callback');
  const scopes = url.searchParams.get('scope').split(',');
  for (const s of ['pages_manage_posts', 'instagram_content_publish', 'pages_manage_engagement', 'instagram_manage_comments', 'ads_read', 'business_management']) {
    assert.ok(scopes.includes(s), `falta el permiso ${s}`);
  }

  route = (c) => {
    if (c.path.endsWith('/oauth/access_token') && c.query.code) return { body: { access_token: 'corto' } };
    if (c.path.endsWith('/oauth/access_token') && c.query.fb_exchange_token === 'corto') return { body: { access_token: 'largo' } };
    if (c.path.endsWith('/me/accounts') && c.query.access_token === 'largo') {
      return {
        body: {
          data: [{ id: 'P1', name: 'Shiluv', access_token: 'tok-pagina', instagram_business_account: { id: 'IG1', username: 'shiluv' } }],
        },
      };
    }
    return null;
  };
  const cb = await callback('meta', { code: 'COD', state: url.searchParams.get('state') });
  assert.match(cb.payload, /Autorizado/);
  assert.equal(calls[0].query.redirect_uri, 'https://app.test/api/social/oauth/meta/callback');

  const pages = await H.runController(ctrl.metaPages, H.mockReq(clinicId, userId));
  assert.equal(pages.payload[0].instagram.username, 'shiluv');
  assert.equal(pages.payload[0].accessToken, undefined, 'el token de la Página no sale al navegador');

  const add = await H.runController(ctrl.metaAddAccounts, H.mockReq(clinicId, userId, { facebook: ['P1'], instagram: ['IG1'] }));
  assert.equal(add.payload.added, 2);
  const ig = await SocialAccount.findOne({ network: 'instagram' }).lean();
  assert.equal(ig.accessToken, 'tok-pagina', 'Instagram publica con el token de su Página');
  assert.equal(ig.pageId, 'P1');
  assert.equal((await SocialPublishingConfig.findOne({ clinic: clinicId })).metaPending.userToken, '', 'el token pendiente se borra');
});

test('Facebook: foto con `caption` (no `message`) y reel en tres pasos con el archivo por URL', async () => {
  const { clinicId, userId } = ids();
  const fb = await SocialAccount.create({ clinic: clinicId, network: 'facebook', externalId: 'P1', name: 'Shiluv', accessToken: 'tok' });
  const img = await ChatGalleryImage.create({ clinic: clinicId, name: 'f.jpg', storageKey: 'x.jpg', mimeType: 'image/jpeg', size: 1000, kind: 'social' });
  const vid = await videoEnDisco(clinicId);
  let listo = false;
  route = (c) => {
    if (c.path.endsWith('/P1/photos')) return { body: { id: 'PH1', post_id: 'P1_9' } };
    if (c.path.endsWith('/P1_9')) return { body: { permalink_url: 'https://www.facebook.com/p/9' } };
    if (c.path.endsWith('/P1/video_reels') && c.body.upload_phase === 'start') return { body: { video_id: 'V1', upload_url: 'https://rupload.facebook.com/video-upload/v25.0/V1' } };
    if (c.host === 'rupload.facebook.com') return { body: { success: true } };
    if (c.path.endsWith('/P1/video_reels') && c.body.upload_phase === 'finish') return { body: { success: true } };
    if (c.path.endsWith('/V1')) {
      return { body: { status: { video_status: listo ? 'processing' : 'processing', publishing_phase: { status: listo ? 'completed' : 'in_progress' } }, permalink_url: '/reel/V1' } };
    }
    return null;
  };
  const post = await SocialPost.create({
    clinic: clinicId, title: 'X', caption: 'Hola', status: 'scheduled', scheduledAt: past(), createdBy: userId,
    media: [{ media: img._id, mimeType: 'image/jpeg', size: 1000 }],
    targets: [{ network: 'facebook', account: fb._id, format: 'post' }],
  });
  await processDueSocialPosts();
  const foto = calls.find((c) => c.path.endsWith('/P1/photos'));
  assert.equal(foto.body.caption, 'Hola');
  assert.equal(foto.body.message, undefined);
  assert.equal((await SocialPost.findById(post._id).lean()).targets[0].permalink, 'https://www.facebook.com/p/9');

  calls = [];
  const reel = await SocialPost.create({
    clinic: clinicId, title: 'R', caption: 'Reel', status: 'scheduled', scheduledAt: past(), createdBy: userId,
    media: [{ media: vid._id, mimeType: 'video/mp4', size: 1000, duration: 20 }],
    targets: [{ network: 'facebook', account: fb._id, format: 'reel' }],
  });
  await processDueSocialPosts();
  const up = calls.find((c) => c.host === 'rupload.facebook.com');
  assert.equal(up.path, '/video-upload/v25.0/V1');
  assert.equal(up.headers.Authorization, 'OAuth tok');
  assert.equal(up.headers.file_url, `https://app.test/api/public/media/${vid._id}`);
  const fin = calls.find((c) => c.body.upload_phase === 'finish');
  assert.equal(fin.body.video_state, 'PUBLISHED');
  assert.equal(fin.body.description, 'Reel');
  let saved = await SocialPost.findById(reel._id);
  assert.equal(saved.targets[0].status, 'processing');

  // La documentación escribe «completed» en unas partes y «complete» en otras.
  listo = true;
  saved.nextRunAt = past();
  saved.targets[0].nextCheckAt = past();
  await saved.save();
  await processDueSocialPosts();
  saved = await SocialPost.findById(reel._id).lean();
  assert.equal(saved.targets[0].status, 'published');
  assert.equal(saved.targets[0].permalink, 'https://www.facebook.com/reel/V1');
});

// ───────────────────────────── TikTok ─────────────────────────────

test('TikTok: OAuth sin pedir campos de un permiso que no tenemos; el @usuario sale de creator_info', async () => {
  const { clinicId, userId } = ids();
  await SocialPublishingConfig.create({ clinic: clinicId, tiktok: { clientKey: 'CK', clientSecret: 'CS' } });
  const r = await H.runController(ctrl.oauthUrl, H.mockReq(clinicId, userId, {}, { params: { network: 'tiktok' } }));
  const url = new URL(r.payload.url);
  assert.equal(url.origin + url.pathname, 'https://www.tiktok.com/v2/auth/authorize/');
  assert.equal(url.searchParams.get('scope'), 'user.info.basic,video.publish,video.upload');

  route = (c) => {
    if (c.path === '/v2/oauth/token/') {
      return { body: { access_token: 'at', refresh_token: 'rt', open_id: 'OPEN1', expires_in: 86400, refresh_expires_in: 31536000, scope: 'user.info.basic,video.publish' } };
    }
    if (c.path === '/v2/user/info/') return { body: { data: { user: { open_id: 'OPEN1', display_name: 'Shiluv', avatar_url: 'https://a' } }, error: { code: 'ok' } } };
    if (c.path === '/v2/post/publish/creator_info/query/') return { body: { data: { creator_username: 'shiluv.ec' }, error: { code: 'ok' } } };
    return null;
  };
  const cb = await callback('tiktok', { code: 'COD', state: url.searchParams.get('state') });
  assert.match(cb.payload, /TikTok conectado/);
  const tok = calls.find((c) => c.path === '/v2/oauth/token/');
  assert.equal(tok.body.client_key, 'CK');
  assert.equal(tok.body.grant_type, 'authorization_code');
  const info = calls.find((c) => c.path === '/v2/user/info/');
  assert.ok(!info.query.fields.includes('username'), '`username` es de user.info.profile: pedirlo haría fallar la conexión');
  const acc = await SocialAccount.findOne({ network: 'tiktok' }).lean();
  assert.equal(acc.username, 'shiluv.ec');
  assert.equal(acc.externalId, 'OPEN1');
});

test('TikTok: renueva el token vencido, sube el video por trozos y publica directo', async () => {
  const { clinicId, userId } = ids();
  await SocialPublishingConfig.create({ clinic: clinicId, tiktok: { clientKey: 'CK', clientSecret: 'CS' } });
  const tt = await SocialAccount.create({
    clinic: clinicId, network: 'tiktok', externalId: 'OPEN1', username: 'shiluv.ec', accessToken: 'viejo', refreshToken: 'rt',
    tokenExpiresAt: new Date(Date.now() - 1000),
  });
  const vid = await videoEnDisco(clinicId, 1000);
  route = (c) => {
    if (c.path === '/v2/oauth/token/' && c.body.grant_type === 'refresh_token') {
      return { body: { access_token: 'nuevo', refresh_token: 'rt2', open_id: 'OPEN1', expires_in: 86400, refresh_expires_in: 31536000 } };
    }
    if (c.path === '/v2/post/publish/video/init/') return { body: { data: { publish_id: 'PUB1', upload_url: 'https://open-upload.tiktokapis.com/up/1' }, error: { code: 'ok' } } };
    if (c.path === '/v2/post/publish/status/fetch/') return { body: { data: { status: 'PUBLISH_COMPLETE', publicaly_available_post_id: [7123] }, error: { code: 'ok' } } };
    return null;
  };
  const post = await SocialPost.create({
    clinic: clinicId, title: 'T', caption: 'Mira esto', hashtags: ['salud'], status: 'scheduled', scheduledAt: past(), createdBy: userId,
    media: [{ media: vid._id, mimeType: 'video/mp4', size: 1000, duration: 15 }],
    targets: [{ network: 'tiktok', account: tt._id, format: 'video', options: { postMode: 'direct', privacyLevel: 'SELF_ONLY', allowComment: true } }],
  });
  await processDueSocialPosts();

  const init = calls.find((c) => c.path === '/v2/post/publish/video/init/');
  assert.equal(init.headers.Authorization, 'Bearer nuevo', 'usa el token renovado');
  assert.equal(init.body.post_info.privacy_level, 'SELF_ONLY');
  assert.equal(init.body.post_info.title, 'Mira esto\n\n#salud');
  assert.equal(init.body.post_info.disable_comment, false);
  assert.equal(init.body.post_info.disable_duet, true, 'interacciones desmarcadas = desactivadas');
  assert.deepEqual(init.body.source_info, { source: 'FILE_UPLOAD', video_size: 1000, chunk_size: 1000, total_chunk_count: 1 });
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].method, 'PUT');
  assert.equal(uploads[0].headers['Content-Range'], 'bytes 0-999/1000');
  assert.equal((await SocialAccount.findById(tt._id).lean()).accessToken, 'nuevo', 'el token renovado se guarda');

  const saved = await SocialPost.findById(post._id);
  assert.equal(saved.targets[0].status, 'processing');
  saved.nextRunAt = past();
  saved.targets[0].nextCheckAt = past();
  await saved.save();
  await processDueSocialPosts();
  const fin = await SocialPost.findById(post._id).lean();
  assert.equal(fin.targets[0].status, 'published');
  assert.equal(fin.targets[0].permalink, 'https://www.tiktok.com/@shiluv.ec/video/7123');
});

test('TikTok: el error de app sin auditar se explica en claro y no se reintenta', async () => {
  const { clinicId, userId } = ids();
  const tt = await SocialAccount.create({ clinic: clinicId, network: 'tiktok', externalId: 'O', accessToken: 'at', tokenExpiresAt: new Date(Date.now() + 3600e3) });
  const vid = await videoEnDisco(clinicId);
  route = (c) => (c.path === '/v2/post/publish/video/init/'
    ? { status: 403, body: { error: { code: 'unaudited_client_can_only_post_to_private_accounts', message: 'x' } } }
    : null);
  const post = await SocialPost.create({
    clinic: clinicId, title: 'T', status: 'scheduled', scheduledAt: past(), createdBy: userId,
    media: [{ media: vid._id, mimeType: 'video/mp4', size: 1000 }],
    targets: [{ network: 'tiktok', account: tt._id, format: 'video', options: { privacyLevel: 'PUBLIC_TO_EVERYONE' } }],
  });
  await processDueSocialPosts();
  const t = (await SocialPost.findById(post._id).lean()).targets[0];
  assert.equal(t.status, 'failed');
  assert.match(t.error, /no auditó la app/);
});

// ───────────────────────────── YouTube ─────────────────────────────

test('YouTube: OAuth con acceso permanente y subida reanudable con los datos del video', async () => {
  const { clinicId, userId } = ids();
  await SocialPublishingConfig.create({ clinic: clinicId, google: { clientId: 'GID', clientSecret: 'GS' } });
  const r = await H.runController(ctrl.oauthUrl, H.mockReq(clinicId, userId, {}, { params: { network: 'youtube' } }));
  const url = new URL(r.payload.url);
  assert.equal(url.searchParams.get('access_type'), 'offline');
  assert.equal(url.searchParams.get('prompt'), 'consent');

  route = (c) => {
    if (c.host === 'oauth2.googleapis.com') return { body: { access_token: 'gat', refresh_token: 'grt', expires_in: 3599, scope: 'x' } };
    if (c.path === '/youtube/v3/channels') return { body: { items: [{ id: 'UC1', snippet: { title: 'Shiluv TV', customUrl: '@shiluv' } }] } };
    if (c.path === '/upload/youtube/v3/videos') return { body: {}, headers: { location: 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1' } };
    return null;
  };
  await callback('youtube', { code: 'COD', state: url.searchParams.get('state') });
  const yt = await SocialAccount.findOne({ network: 'youtube' });
  assert.equal(yt.externalId, 'UC1');
  assert.equal(yt.refreshToken, 'grt');

  const vid = await videoEnDisco(clinicId, 2048);
  const post = await SocialPost.create({
    clinic: clinicId, title: 'Interno', caption: 'Descripción <b>', hashtags: ['salud', 'bienestar'], status: 'scheduled', scheduledAt: past(), createdBy: userId,
    media: [{ media: vid._id, mimeType: 'video/mp4', size: 2048, duration: 40, width: 1080, height: 1920 }],
    targets: [{ network: 'youtube', account: yt._id, format: 'short', title: 'Sueros <rápido>', options: { privacyStatus: 'unlisted', madeForKids: false, categoryId: '26' } }],
  });
  await processDueSocialPosts();

  const init = calls.find((c) => c.path === '/upload/youtube/v3/videos');
  assert.equal(init.query.uploadType, 'resumable');
  assert.equal(init.headers['X-Upload-Content-Length'], '2048');
  assert.equal(init.body.snippet.title, 'Sueros rápido', 'sin < > (YouTube los rechaza)');
  assert.match(init.body.snippet.description, /#Shorts/);
  assert.deepEqual(init.body.snippet.tags, ['salud', 'bienestar']);
  assert.equal(init.body.status.privacyStatus, 'unlisted');
  assert.equal(init.body.status.selfDeclaredMadeForKids, false);
  assert.equal(uploads[0].url, 'https://www.googleapis.com/upload/youtube/v3/videos?upload_id=U1');
  const t = (await SocialPost.findById(post._id).lean()).targets[0];
  assert.equal(t.status, 'published');
  assert.equal(t.permalink, 'https://youtube.com/shorts/VID1');
});

// ───────────────────────────── Comunes ─────────────────────────────

test('los errores de Google se leen como Google (token caducado = reconectar; 503 = reintentar)', () => {
  const caducado = http.errorFromBody(401, { error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }], status: 'UNAUTHENTICATED' } });
  assert.equal(caducado.tokenInvalid, true);
  const caido = http.errorFromBody(503, { error: { code: 503, message: 'Backend Error', errors: [{ reason: 'backendError' }] } });
  assert.equal(caido.retryable, true);
  const meta = http.errorFromBody(400, { error: { message: 'x', type: 'OAuthException', code: 190, fbtrace_id: 'f' } });
  assert.equal(meta.tokenInvalid, true);
});

test('un servidor sin SECRETS_KEY no marca la cuenta como rota: reintenta y deja publicar al que sí la tiene', async () => {
  const { clinicId, userId } = ids();
  const fb = await SocialAccount.create({ clinic: clinicId, network: 'facebook', externalId: 'P1', accessToken: 'enc:v1:aaa:bbb:ccc' });
  const post = await SocialPost.create({
    clinic: clinicId, title: 'X', caption: 'Hola', status: 'scheduled', scheduledAt: past(), createdBy: userId,
    targets: [{ network: 'facebook', account: fb._id, format: 'post' }],
  });
  await processDueSocialPosts();
  assert.equal(calls.length, 0, 'no se manda el token cifrado a Meta');
  const t = (await SocialPost.findById(post._id).lean()).targets[0];
  assert.equal(t.status, 'pending');
  assert.match(t.error, /SECRETS_KEY/);
  assert.equal((await SocialAccount.findById(fb._id).lean()).status, 'connected');
});

test('el callback rechaza un `state` ajeno o caducado', async () => {
  const otro = oauth.signState({ userId: 'u', clinicId: 'c', network: 'tiktok' });
  const r = await callback('youtube', { code: 'C', state: otro });
  assert.match(r.payload, /caducó o no es válido/);
  assert.equal(calls.length, 0);
});
