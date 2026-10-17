/**
 * Publicación en Facebook (Páginas) e Instagram (cuentas profesionales) por la
 * Graph API oficial de Meta, con el token de la Página.
 *
 * Permisos que la app debe tener aprobados en la revisión de Meta:
 *   pages_show_list, pages_read_engagement, pages_manage_posts,
 *   instagram_basic, instagram_content_publish (+ business_management si las
 *   Páginas están en un portafolio comercial).
 *
 * Meta DESCARGA los medios de nuestra URL pública (/api/public/media/:id); por
 * eso el servidor necesita PUBLIC_API_URL y ser accesible desde internet.
 *
 * Contrato de cada publicador (lo usa utils/social/publisher):
 *   start(ctx) / check(ctx) → { status: 'published', externalId, permalink }
 *                           | { status: 'processing', state, checkInMs }
 *   Lanzan SocialApiError ante un fallo.
 */
const { request, SocialApiError } = require('./http');
const { composeText, isImage, isVideo } = require('./rules');
const { publicMediaUrl } = require('./media');

const VERSION = () => process.env.SOCIAL_META_GRAPH_VERSION || 'v23.0';

const OAUTH_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
  'business_management',
];

async function graph(path, { method = 'GET', token, params = {}, host = 'graph.facebook.com' } = {}) {
  const url = new URL(`https://${host}/${VERSION()}/${String(path).replace(/^\/+/, '')}`);
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    if (token) url.searchParams.set('access_token', token);
    return (await request(url.toString())).data;
  }
  return (await request(url.toString(), { method, form: { ...params, access_token: token } })).data;
}

const absoluteFbUrl = (u) => (!u ? '' : /^https?:/i.test(u) ? u : `https://www.facebook.com${u.startsWith('/') ? '' : '/'}${u}`);

async function permalinkOf(id, token, field = 'permalink_url') {
  try {
    const d = await graph(id, { token, params: { fields: field } });
    return absoluteFbUrl(d[field] || '');
  } catch {
    return '';
  }
}

const done = (externalId, permalink = '') => ({ status: 'published', externalId: String(externalId || ''), permalink });
const processing = (state, checkInMs = 30 * 1000) => ({ status: 'processing', state, checkInMs });

// ───────────────────────────── Facebook ─────────────────────────────

/** Sube un video a Meta por URL (reels e historias usan el mismo cargador). */
async function uploadByUrl({ uploadUrl, videoId, token, fileUrl }) {
  const url = uploadUrl || `https://rupload.facebook.com/video-upload/${VERSION()}/${videoId}`;
  await request(url, { method: 'POST', headers: { Authorization: `OAuth ${token}`, file_url: fileUrl } });
}

async function startFacebook({ post, target, account, token }) {
  const pageId = account.externalId;
  const media = post.media || [];
  const videos = media.filter(isVideo);
  const images = media.filter(isImage);

  if (target.format === 'post') {
    if (!media.length) {
      const message = composeText(post, target, { includeLink: false });
      const r = await graph(`${pageId}/feed`, { method: 'POST', token, params: { message, link: post.link || undefined } });
      return done(r.id, await permalinkOf(r.id, token));
    }
    const message = composeText(post, target);
    if (videos.length) {
      const r = await graph(`${pageId}/videos`, {
        method: 'POST',
        token,
        host: 'graph-video.facebook.com',
        params: { file_url: publicMediaUrl(videos[0].media), description: message },
      });
      return processing({ kind: 'fb_video', videoId: r.id, since: Date.now() }, 60 * 1000);
    }
    if (images.length === 1) {
      const r = await graph(`${pageId}/photos`, { method: 'POST', token, params: { url: publicMediaUrl(images[0].media), message } });
      const id = r.post_id || r.id;
      return done(id, await permalinkOf(id, token));
    }
    // Varias fotos: se suben sin publicar y se adjuntan a UNA publicación.
    const params = { message };
    for (let i = 0; i < images.length; i += 1) {
      const p = await graph(`${pageId}/photos`, {
        method: 'POST',
        token,
        params: { url: publicMediaUrl(images[i].media), published: false },
      });
      params[`attached_media[${i}]`] = JSON.stringify({ media_fbid: p.id });
    }
    const r = await graph(`${pageId}/feed`, { method: 'POST', token, params });
    return done(r.id, await permalinkOf(r.id, token));
  }

  if (target.format === 'reel') {
    const s = await graph(`${pageId}/video_reels`, { method: 'POST', token, params: { upload_phase: 'start' } });
    await uploadByUrl({ uploadUrl: s.upload_url, videoId: s.video_id, token, fileUrl: publicMediaUrl(videos[0].media) });
    await graph(`${pageId}/video_reels`, {
      method: 'POST',
      token,
      params: { upload_phase: 'finish', video_id: s.video_id, video_state: 'PUBLISHED', description: composeText(post, target) },
    });
    return processing({ kind: 'fb_video', videoId: s.video_id, since: Date.now() }, 45 * 1000);
  }

  if (target.format === 'story') {
    const m = media[0];
    if (isImage(m)) {
      const photo = await graph(`${pageId}/photos`, { method: 'POST', token, params: { url: publicMediaUrl(m.media), published: false } });
      const r = await graph(`${pageId}/photo_stories`, { method: 'POST', token, params: { photo_id: photo.id } });
      return done(r.post_id || photo.id);
    }
    const s = await graph(`${pageId}/video_stories`, { method: 'POST', token, params: { upload_phase: 'start' } });
    await uploadByUrl({ uploadUrl: s.upload_url, videoId: s.video_id, token, fileUrl: publicMediaUrl(m.media) });
    const r = await graph(`${pageId}/video_stories`, { method: 'POST', token, params: { upload_phase: 'finish', video_id: s.video_id } });
    return done(r.post_id || s.video_id);
  }

  throw new SocialApiError('Formato no soportado en Facebook');
}

async function checkFacebook({ target, token }) {
  const st = target.state || {};
  if (st.kind !== 'fb_video') throw new SocialApiError('Estado de publicación desconocido');
  const d = await graph(st.videoId, { token, params: { fields: 'status,permalink_url' } });
  const s = d.status || {};
  const videoStatus = s.video_status || '';
  if (videoStatus === 'error' || s.processing_phase?.status === 'error' || s.publishing_phase?.status === 'error') {
    const why = s.processing_phase?.errors?.[0]?.message || s.publishing_phase?.errors?.[0]?.message || 'Facebook no pudo procesar el video';
    throw new SocialApiError(why);
  }
  if (videoStatus === 'ready' || s.publishing_phase?.status === 'complete') {
    return done(st.videoId, absoluteFbUrl(d.permalink_url || ''));
  }
  if (Date.now() - (st.since || 0) > 2 * 60 * 60 * 1000) {
    throw new SocialApiError('Facebook lleva más de 2 horas procesando el video');
  }
  return processing(st, 60 * 1000);
}

// ───────────────────────────── Instagram ─────────────────────────────

async function createContainer(igId, token, params) {
  const r = await graph(`${igId}/media`, { method: 'POST', token, params });
  return r.id;
}

async function containerStatus(id, token) {
  const d = await graph(id, { token, params: { fields: 'status_code,status' } });
  return { code: d.status_code || '', detail: d.status || '' };
}

function containerParams(post, target, m, coverUrl) {
  const caption = composeText(post, target);
  const url = publicMediaUrl(m.media);
  if (target.format === 'story') return isVideo(m) ? { media_type: 'STORIES', video_url: url } : { media_type: 'STORIES', image_url: url };
  if (isVideo(m)) {
    // En Instagram un video del feed ES un reel (VIDEO quedó obsoleto).
    const shareToFeed = target.format === 'post' ? true : target.options?.shareToFeed !== false;
    return { media_type: 'REELS', video_url: url, caption, share_to_feed: shareToFeed, cover_url: coverUrl || undefined };
  }
  return { image_url: url, caption };
}

async function publishContainer(igId, token, creationId) {
  const r = await graph(`${igId}/media_publish`, { method: 'POST', token, params: { creation_id: creationId } });
  return done(r.id, await permalinkOf(r.id, token, 'permalink'));
}

/** Mira el contenedor y, si ya está listo, publica. */
async function advanceContainer(igId, token, st) {
  const { code, detail } = await containerStatus(st.containerId, token);
  if (code === 'FINISHED') return publishContainer(igId, token, st.containerId);
  if (code === 'PUBLISHED') return done(st.mediaId || st.containerId);
  if (code === 'ERROR' || code === 'EXPIRED') {
    throw new SocialApiError(`Instagram rechazó el medio${detail ? `: ${detail}` : ''} (revisa formato, proporción y duración)`);
  }
  if (Date.now() - (st.since || 0) > 2 * 60 * 60 * 1000) throw new SocialApiError('Instagram lleva más de 2 horas procesando el medio');
  return processing(st, 20 * 1000);
}

async function startInstagram({ post, target, account, token }) {
  const igId = account.externalId;
  const media = post.media || [];
  const coverUrl = post.cover?.media ? publicMediaUrl(post.cover.media) : '';

  if (target.format === 'carousel') {
    const children = [];
    for (const m of media) {
      const params = isVideo(m)
        ? { media_type: 'VIDEO', video_url: publicMediaUrl(m.media), is_carousel_item: true }
        : { image_url: publicMediaUrl(m.media), is_carousel_item: true };
      children.push(await createContainer(igId, token, params));
    }
    return checkInstagram({ post, target, account, token, stateOverride: { kind: 'ig_carousel', children, since: Date.now() } });
  }

  const containerId = await createContainer(igId, token, containerParams(post, target, media[0], coverUrl));
  return advanceContainer(igId, token, { kind: 'ig_single', containerId, since: Date.now() });
}

async function checkInstagram({ post, target, account, token, stateOverride }) {
  const igId = account.externalId;
  const st = stateOverride || target.state || {};
  if (st.kind === 'ig_single') return advanceContainer(igId, token, st);
  if (st.kind === 'ig_carousel') {
    if (!st.containerId) {
      // Primero cada elemento debe terminar de procesarse (los videos tardan).
      for (const id of st.children || []) {
        const { code, detail } = await containerStatus(id, token);
        if (code === 'ERROR' || code === 'EXPIRED') throw new SocialApiError(`Instagram rechazó un elemento del carrusel${detail ? `: ${detail}` : ''}`);
        if (code !== 'FINISHED') {
          if (Date.now() - (st.since || 0) > 2 * 60 * 60 * 1000) throw new SocialApiError('Instagram lleva más de 2 horas procesando el carrusel');
          return processing(st, 20 * 1000);
        }
      }
      const containerId = await createContainer(igId, token, {
        media_type: 'CAROUSEL',
        children: (st.children || []).join(','),
        caption: composeText(post, target),
      });
      return advanceContainer(igId, token, { ...st, containerId });
    }
    return advanceContainer(igId, token, st);
  }
  throw new SocialApiError('Estado de publicación desconocido');
}

// ───────────────────────────── Comunes ─────────────────────────────

async function comment({ target, token, message }) {
  // Facebook e Instagram usan el mismo borde /{objeto}/comments.
  await graph(`${target.externalId}/comments`, { method: 'POST', token, params: { message } });
}

function oauthUrl({ appId, redirectUri, state }) {
  const u = new URL(`https://www.facebook.com/${VERSION()}/dialog/oauth`);
  u.searchParams.set('client_id', appId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', OAUTH_SCOPES.join(','));
  return u.toString();
}

/** code → token de usuario de LARGA duración (los tokens de Página que salen de él no caducan). */
async function exchangeCode({ appId, appSecret, code, redirectUri }) {
  const short = await graph('oauth/access_token', {
    params: { client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code },
  });
  const long = await graph('oauth/access_token', {
    params: { grant_type: 'fb_exchange_token', client_id: appId, client_secret: appSecret, fb_exchange_token: short.access_token },
  });
  return long.access_token || short.access_token;
}

/** Páginas que administra el token, cada una con su token y su Instagram vinculado. */
async function listPages(userToken) {
  const pages = [];
  let url = null;
  let data = await graph('me/accounts', {
    token: userToken,
    params: {
      fields: 'id,name,access_token,picture{url},instagram_business_account{id,username,name,profile_picture_url}',
      limit: 100,
    },
  });
  for (let guard = 0; guard < 20; guard += 1) {
    pages.push(...(data.data || []));
    url = data.paging?.next;
    if (!url) break;
    data = (await request(url)).data;
  }
  return pages.map((p) => ({
    id: p.id,
    name: p.name,
    accessToken: p.access_token,
    picture: p.picture?.data?.url || '',
    instagram: p.instagram_business_account
      ? {
          id: p.instagram_business_account.id,
          username: p.instagram_business_account.username || '',
          name: p.instagram_business_account.name || '',
          picture: p.instagram_business_account.profile_picture_url || '',
        }
      : null,
  }));
}

/** Comprueba que el token de la cuenta siga sirviendo (botón «Verificar»). */
async function checkAccount(account, token) {
  if (account.network === 'instagram') {
    const d = await graph(account.externalId, { token, params: { fields: 'username,name,profile_picture_url' } });
    return { name: d.name || account.name, username: d.username || account.username, avatarUrl: d.profile_picture_url || account.avatarUrl };
  }
  const d = await graph(account.externalId, { token, params: { fields: 'name,picture{url}' } });
  return { name: d.name || account.name, avatarUrl: d.picture?.data?.url || account.avatarUrl };
}

module.exports = {
  OAUTH_SCOPES,
  checkAccount,
  checkFacebook,
  checkInstagram,
  comment,
  exchangeCode,
  graph,
  listPages,
  oauthUrl,
  startFacebook,
  startInstagram,
};
