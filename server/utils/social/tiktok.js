/**
 * Publicación en TikTok por la Content Posting API oficial.
 *
 * OJO con la auditoría: mientras TikTok no audite nuestra app, TODO lo que se
 * publique sale PRIVADO («solo yo») y solo 5 cuentas pueden publicar al día.
 * Se puede usar el modo «borrador» (inbox): el video llega a la app de TikTok
 * del creador como notificación y lo termina de publicar desde el teléfono.
 *
 * Reglas de TikTok para la pantalla de publicación directa (las cumple el
 * editor del cliente): mostrar el nombre de la cuenta, consultar creator_info,
 * que la privacidad la elija la persona sin valor por defecto, interacciones
 * desmarcadas por defecto, divulgación de contenido comercial y la declaración
 * de la política de música antes del botón.
 *
 * Videos: se SUBEN los bytes desde el disco (FILE_UPLOAD), así no hace falta
 * verificar el dominio. Fotos: TikTok solo admite PULL_FROM_URL, que exige
 * verificar el dominio de la API en el portal de desarrolladores de TikTok.
 */
// `http.uploadFileRange` (y no una copia) para que las pruebas puedan interceptar la subida.
const http = require('./http');

const { request, SocialApiError } = http;
const { composeText, isImage, isVideo, LIMITS } = require('./rules');
const { mediaFile, publicMediaUrl } = require('./media');

const API = 'https://open.tiktokapis.com/v2';
const SCOPES = ['user.info.basic', 'video.publish', 'video.upload'];

const auth = (token) => ({ Authorization: `Bearer ${token}` });

function oauthUrl({ clientKey, redirectUri, state }) {
  const u = new URL('https://www.tiktok.com/v2/auth/authorize/');
  u.searchParams.set('client_key', clientKey);
  u.searchParams.set('scope', SCOPES.join(','));
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  return u.toString();
}

function tokenResult(d) {
  const now = Date.now();
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token,
    openId: d.open_id,
    scopes: String(d.scope || '').split(',').filter(Boolean),
    tokenExpiresAt: new Date(now + Number(d.expires_in || 0) * 1000),
    refreshExpiresAt: d.refresh_expires_in ? new Date(now + Number(d.refresh_expires_in) * 1000) : null,
  };
}

async function exchangeCode({ clientKey, clientSecret, code, redirectUri }) {
  const { data } = await request(`${API}/oauth/token/`, {
    method: 'POST',
    form: { client_key: clientKey, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: redirectUri },
  });
  return tokenResult(data);
}

async function refresh({ clientKey, clientSecret, refreshToken }) {
  const { data } = await request(`${API}/oauth/token/`, {
    method: 'POST',
    form: { client_key: clientKey, client_secret: clientSecret, grant_type: 'refresh_token', refresh_token: refreshToken },
  });
  return tokenResult(data);
}

/**
 * Perfil del creador. Solo campos de `user.info.basic`: `username` es de
 * `user.info.profile`, un permiso que no pedimos (pedirlo sin tenerlo hace
 * fallar la conexión). El @usuario sale de creator_info, que va con video.publish.
 */
async function userInfo(token) {
  const { data } = await request(`${API}/user/info/?fields=open_id,avatar_url,display_name`, { headers: auth(token) });
  const u = data?.data?.user || {};
  let username = '';
  try {
    username = (await creatorInfo(token)).creator_username || '';
  } catch {
    /* sin @usuario la cuenta funciona igual; solo falta el enlace público */
  }
  return { openId: u.open_id, name: u.display_name || '', username, avatarUrl: u.avatar_url || '' };
}

/** Lo que el creador permite AHORA (privacidades, interacciones, duración máxima). */
async function creatorInfo(token) {
  const { data } = await request(`${API}/post/publish/creator_info/query/`, { method: 'POST', headers: auth(token), json: {} });
  return data?.data || {};
}

// Los errores de TikTok que el equipo va a ver de verdad, dichos en claro.
const ERRORES = {
  unaudited_client_can_only_post_to_private_accounts:
    'TikTok todavía no auditó la app: solo se puede publicar con la cuenta en privado y con «Solo yo». Usa «Enviar como borrador» mientras tanto.',
  url_ownership_unverified: 'Para publicar fotos hay que verificar el dominio de la API en el portal de desarrolladores de TikTok.',
  privacy_level_option_mismatch: 'La privacidad elegida ya no está disponible en esta cuenta: vuelve a elegirla.',
  spam_risk_too_many_posts: 'La cuenta llegó al límite diario de publicaciones de TikTok.',
  spam_risk_user_banned_from_posting: 'TikTok tiene bloqueada la publicación en esta cuenta.',
  reached_active_user_cap: 'La app alcanzó el cupo diario de cuentas que pueden publicar (app sin auditar: 5 al día).',
};

function traducir(err) {
  const msg = ERRORES[err?.code];
  if (msg) {
    err.message = msg;
    err.retryable = false;
  }
  return err;
}

/**
 * Tramos de subida: TikTok exige trozos de 5 a 64 MB (el último puede llegar a
 * 128 MB) y un archivo de menos de 64 MB se sube de una vez.
 */
function chunkPlan(size) {
  const MAX_SINGLE = 64 * 1024 * 1024;
  if (size <= MAX_SINGLE) return { chunkSize: size, count: 1 };
  const chunkSize = 10 * 1024 * 1024;
  return { chunkSize, count: Math.floor(size / chunkSize) };
}

function postInfo(post, target, { photo = false } = {}) {
  const o = target.options || {};
  const info = {
    privacy_level: o.privacyLevel,
    disable_comment: !o.allowComment,
    brand_content_toggle: Boolean(o.brandContent),
    brand_organic_toggle: Boolean(o.brandOrganic),
  };
  if (photo) {
    info.title = String(target.title || post.title || '').slice(0, LIMITS.tiktokPhotoTitle);
    info.description = composeText(post, target).slice(0, LIMITS.tiktokPhotoDescription);
    info.auto_add_music = true;
  } else {
    info.title = composeText(post, target).slice(0, LIMITS.tiktokVideoCaption);
    info.disable_duet = !o.allowDuet;
    info.disable_stitch = !o.allowStitch;
    info.is_aigc = Boolean(o.isAigc);
  }
  return info;
}

async function start(ctx) {
  try {
    return await startRaw(ctx);
  } catch (err) {
    throw traducir(err);
  }
}

async function startRaw({ post, target, token }) {
  const media = post.media || [];
  const o = target.options || {};

  if (target.format === 'photo') {
    const images = media.filter(isImage);
    const { data } = await request(`${API}/post/publish/content/init/`, {
      method: 'POST',
      headers: auth(token),
      json: {
        post_info: postInfo(post, target, { photo: true }),
        source_info: { source: 'PULL_FROM_URL', photo_cover_index: 0, photo_images: images.map((m) => publicMediaUrl(m.media)) },
        post_mode: 'DIRECT_POST',
        media_type: 'PHOTO',
      },
    });
    return { status: 'processing', state: { kind: 'tt', publishId: data.data.publish_id, since: Date.now() }, checkInMs: 20 * 1000 };
  }

  const video = media.find(isVideo);
  if (!video) throw new SocialApiError('Falta el video');
  const file = await mediaFile(video.media);
  const { chunkSize, count } = chunkPlan(file.size);
  const sourceInfo = { source: 'FILE_UPLOAD', video_size: file.size, chunk_size: chunkSize, total_chunk_count: count };
  const inbox = o.postMode === 'inbox';
  const { data } = await request(`${API}/post/publish/${inbox ? 'inbox/video' : 'video'}/init/`, {
    method: 'POST',
    headers: auth(token),
    json: inbox ? { source_info: sourceInfo } : { post_info: postInfo(post, target), source_info: sourceInfo },
  });
  const { publish_id: publishId, upload_url: uploadUrl } = data.data || {};
  for (let i = 0; i < count; i += 1) {
    const from = i * chunkSize;
    const to = i === count - 1 ? file.size - 1 : from + chunkSize - 1;
    await http.uploadFileRange(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': file.mimeType || 'video/mp4', 'Content-Range': `bytes ${from}-${to}/${file.size}` },
      filePath: file.path,
      start: from,
      end: to,
    });
  }
  return { status: 'processing', state: { kind: 'tt', publishId, inbox, since: Date.now() }, checkInMs: 20 * 1000 };
}

async function check({ target, account, token }) {
  const st = target.state || {};
  const { data } = await request(`${API}/post/publish/status/fetch/`, { method: 'POST', headers: auth(token), json: { publish_id: st.publishId } });
  const d = data?.data || {};
  if (d.status === 'FAILED') throw new SocialApiError(`TikTok no pudo publicar: ${d.fail_reason || 'motivo desconocido'}`);
  if (d.status === 'SEND_TO_USER_INBOX') {
    return { status: 'published', externalId: st.publishId, permalink: '', note: 'Enviado a la bandeja de TikTok: termina de publicarlo desde la app.' };
  }
  if (d.status === 'PUBLISH_COMPLETE') {
    const id = (d.publicaly_available_post_id || [])[0];
    const user = account.username || '';
    return {
      status: 'published',
      externalId: String(id || st.publishId),
      permalink: id && user ? `https://www.tiktok.com/@${user}/video/${id}` : '',
      // Sin id público = salió privado (app sin auditar o privacidad «solo yo»).
      note: id ? '' : 'Publicado en TikTok sin enlace público (privado o app sin auditar).',
    };
  }
  if (Date.now() - (st.since || 0) > 2 * 60 * 60 * 1000) throw new SocialApiError('TikTok lleva más de 2 horas procesando la publicación');
  return { status: 'processing', state: st, checkInMs: 30 * 1000 };
}

module.exports = { SCOPES, check, chunkPlan, creatorInfo, exchangeCode, oauthUrl, refresh, start, userInfo };
