/**
 * Publicación en YouTube (videos y Shorts) por la YouTube Data API v3.
 *
 * OJO con la auditoría: si el proyecto de Google Cloud no pasó la auditoría de
 * la API de YouTube, los videos subidos quedan PRIVADOS para siempre aunque se
 * pidan públicos. Cada subida cuesta cuota (videos.insert); la cuota diaria
 * por defecto da para pocas decenas de videos al día.
 *
 * Un Short es un video vertical de hasta 3 minutos: YouTube lo detecta solo.
 * El video se sube en el momento de publicar (subida reanudable, por stream
 * desde el disco) y queda publicado al terminar.
 */
const { request, uploadFileRange, SocialApiError } = require('./http');
const { composeText, normalizeHashtags, youtubeSafe, youtubeTitle, isVideo, LIMITS } = require('./rules');
const { mediaFile } = require('./media');

const SCOPES = ['https://www.googleapis.com/auth/youtube.upload', 'https://www.googleapis.com/auth/youtube.readonly'];

const auth = (token) => ({ Authorization: `Bearer ${token}` });

function oauthUrl({ clientId, redirectUri, state }) {
  const u = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPES.join(' '));
  // offline + consent: es lo que hace que Google entregue el refresh_token.
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('state', state);
  return u.toString();
}

function tokenResult(d, previousRefresh = '') {
  return {
    accessToken: d.access_token,
    // Al refrescar, Google normalmente NO devuelve un refresh_token nuevo.
    refreshToken: d.refresh_token || previousRefresh,
    scopes: String(d.scope || '').split(' ').filter(Boolean),
    tokenExpiresAt: new Date(Date.now() + Number(d.expires_in || 3600) * 1000),
  };
}

async function exchangeCode({ clientId, clientSecret, code, redirectUri }) {
  const { data } = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    form: { code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code' },
  });
  return tokenResult(data);
}

async function refresh({ clientId, clientSecret, refreshToken }) {
  const { data } = await request('https://oauth2.googleapis.com/token', {
    method: 'POST',
    form: { client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' },
  });
  return tokenResult(data, refreshToken);
}

async function channelInfo(token) {
  const { data } = await request('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', { headers: auth(token) });
  const ch = (data.items || [])[0];
  if (!ch) throw new SocialApiError('Esta cuenta de Google no tiene un canal de YouTube');
  return {
    channelId: ch.id,
    name: ch.snippet?.title || '',
    username: ch.snippet?.customUrl || '',
    avatarUrl: ch.snippet?.thumbnails?.default?.url || '',
  };
}

/** Etiquetas de YouTube: los hashtags sin «#», máximo ~500 caracteres en total. */
function youtubeTags(hashtags) {
  const out = [];
  let total = 0;
  for (const h of normalizeHashtags(hashtags)) {
    const t = h.slice(1);
    if (total + t.length + 1 > 480) break;
    out.push(t);
    total += t.length + 1;
  }
  return out;
}

async function start({ post, target, token }) {
  const video = (post.media || []).find(isVideo);
  if (!video) throw new SocialApiError('Falta el video');
  const file = await mediaFile(video.media);
  const o = target.options || {};

  let description = youtubeSafe(composeText(post, target));
  if (target.format === 'short' && !/#shorts\b/i.test(description)) description = `${description}\n\n#Shorts`.trim();
  const meta = {
    snippet: {
      title: youtubeTitle(post, target),
      description: description.slice(0, LIMITS.youtubeDescription),
      tags: youtubeTags(post.hashtags),
      categoryId: String(o.categoryId || '22'),
    },
    status: {
      privacyStatus: o.privacyStatus || 'public',
      selfDeclaredMadeForKids: Boolean(o.madeForKids),
    },
  };

  const init = await request('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status', {
    method: 'POST',
    headers: { ...auth(token), 'X-Upload-Content-Length': String(file.size), 'X-Upload-Content-Type': file.mimeType || 'video/*' },
    json: meta,
  });
  const location = init.headers.get('location');
  if (!location) throw new SocialApiError('YouTube no devolvió la dirección de subida', { retryable: true });
  const up = await uploadFileRange(location, {
    method: 'PUT',
    headers: { ...auth(token), 'Content-Type': file.mimeType || 'video/*' },
    filePath: file.path,
    start: 0,
    end: file.size - 1,
  });
  const videoId = up.data?.id;
  if (!videoId) throw new SocialApiError('YouTube no confirmó la subida del video', { retryable: true });

  // Miniatura propia: solo canales verificados pueden ponerla. Si falla, el
  // video ya está arriba: se deja constancia y no se marca como error.
  let note = '';
  if (post.cover?.media) {
    try {
      const cover = await mediaFile(post.cover.media);
      await uploadFileRange(`https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${videoId}`, {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': cover.mimeType || 'image/jpeg' },
        filePath: cover.path,
        start: 0,
        end: cover.size - 1,
      });
    } catch (err) {
      note = `No se pudo poner la miniatura: ${err.message}`;
    }
  }

  return {
    status: 'published',
    externalId: videoId,
    permalink: target.format === 'short' ? `https://youtube.com/shorts/${videoId}` : `https://youtu.be/${videoId}`,
    note,
  };
}

module.exports = { SCOPES, channelInfo, exchangeCode, oauthUrl, refresh, start, youtubeTags };
