/**
 * Qué trae un evento de mensajería de Instagram, ya traducido a lo que entiende
 * `ingestExternalMessage`.
 *
 * Hasta oct-2026 el webhook solo miraba `message.text`: una respuesta a una
 * HISTORIA llegaba como un "hola" suelto sin saber a qué historia contestaba, una
 * mención en una historia o una publicación compartida (que no traen texto) se
 * tiraban enteras, y el anuncio del que venía la persona se perdía. En WhatsApp
 * ya se veía "📣 Mensaje desde anuncio"; aquí se arma el mismo `referral` para
 * que el chat pinte la misma tarjeta, con la miniatura de la historia/publicación.
 *
 * Formatos (Messenger Platform para Instagram):
 *   - respuesta a historia:  message.reply_to.story = { id, url }
 *   - mención en historia:   message.attachments[] type 'story_mention', payload.url
 *   - publicación / reel:    attachments[] type 'share' | 'ig_post' | 'ig_reel' | 'reel'
 *                            payload { url, title, ig_post_media_id | reel_video_id }
 *   - anuncio:               message.referral (o event.referral) con ad_id y
 *                            ads_context_data { ad_title, photo_url, video_url }
 *   - adjuntos propios:      attachments[] type image | video | audio | file
 *
 * Las URLs que manda Meta son de su CDN y CADUCAN (horas): por eso la miniatura
 * y los adjuntos se descargan al recibirlos (`downloadRemoteMedia`).
 */

const SHARE_TYPES = {
  share: 'ig_post',
  ig_post: 'ig_post',
  ig_reel: 'ig_reel',
  reel: 'ig_reel',
};
const MEDIA_TYPES = { image: 'image', video: 'video', audio: 'audio', file: 'document', animated_image_share: 'image' };

const DEFAULT_BODY = {
  ig_story_mention: '📸 Te mencionó en su historia',
  ig_post: '📎 Compartió una publicación',
  ig_reel: '🎬 Compartió un reel',
};

function adReferralFrom(ref) {
  if (!ref || (!ref.ad_id && String(ref.source || '').toUpperCase() !== 'ADS')) return null;
  const ctx = ref.ads_context_data || {};
  const headline = String(ctx.ad_title || '').trim();
  return {
    adId: String(ref.ad_id || '').trim(),
    campaign: headline,
    ctwaClid: '',
    headline,
    body: '',
    sourceUrl: '',
    sourceType: 'ig_ad',
    mediaRemoteUrl: ctx.photo_url || ctx.video_url || '',
  };
}

/**
 * Un evento puede traer VARIOS adjuntos (varias fotos de golpe). Se devuelve una
 * lista de "partes", cada una un mensaje del chat; la primera lleva el texto y el
 * contexto (historia/anuncio). Lista vacía = nada que guardar.
 */
function parseInstagramEvent(event, { pendingReferral = null } = {}) {
  const message = event?.message;
  if (!message) return [];
  const text = String(message.text || '').trim();
  let referral = adReferralFrom(message.referral) || adReferralFrom(event.referral) || pendingReferral || null;

  const story = message.reply_to?.story;
  if (story && (story.url || story.id)) {
    // Si además vino de un anuncio, manda el anuncio (es lo que mide marketing);
    // la historia queda como miniatura si el anuncio no trae la suya.
    referral = referral
      ? { ...referral, mediaRemoteUrl: referral.mediaRemoteUrl || story.url || '' }
      : {
          adId: '', campaign: '', ctwaClid: '', headline: '', body: '',
          sourceId: String(story.id || ''),
          sourceUrl: '',
          sourceType: 'ig_story_reply',
          mediaRemoteUrl: story.url || '',
        };
  }

  const parts = [];
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  for (const att of attachments) {
    const type = String(att?.type || '');
    const payload = att?.payload || {};
    if (type === 'story_mention') {
      parts.push({
        context: {
          adId: '', campaign: '', ctwaClid: '', headline: '', body: '',
          sourceId: '',
          sourceUrl: '',
          sourceType: 'ig_story_mention',
          mediaRemoteUrl: payload.url || '',
        },
      });
    } else if (SHARE_TYPES[type]) {
      const kind = SHARE_TYPES[type];
      parts.push({
        context: {
          adId: '', campaign: '', ctwaClid: '',
          headline: String(payload.title || '').trim().slice(0, 500),
          body: '',
          sourceId: String(payload.ig_post_media_id || payload.reel_video_id || ''),
          sourceUrl: '',
          sourceType: kind,
          mediaRemoteUrl: payload.url || '',
        },
      });
    } else if (MEDIA_TYPES[type] && payload.url) {
      parts.push({ media: { type: MEDIA_TYPES[type], remoteUrl: payload.url } });
    }
  }

  if (!parts.length) {
    if (!text && !referral) {
      if (message.is_unsupported) {
        return [{ body: '(mensaje que Instagram no permite mostrar aquí — míralo en la app)', referral: null, media: null }];
      }
      return [];
    }
    return [{ body: text, referral, media: null }];
  }

  return parts.map((p, i) => {
    // La primera parte se queda con el texto y el contexto del mensaje (anuncio o
    // historia respondida); si la parte es en sí una historia/publicación, ese es su
    // contexto (un anuncio, si lo hubo, sigue mandando en la primera).
    const ctx = i === 0 ? (referral && referral.adId ? referral : p.context || referral) : p.context || null;
    const ctxBody = p.context ? DEFAULT_BODY[p.context.sourceType] || '' : '';
    const body = i === 0 ? text || ctxBody : ctxBody;
    return { body, referral: ctx || null, media: p.media || null };
  });
}

// Mismo tope que la media de WhatsApp: lo que pase de aquí no se guarda.
const MAX_REMOTE_BYTES = 25 * 1024 * 1024;

function mediaTypeFromMime(mime) {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/')) return 'audio';
  return 'document';
}

/**
 * Baja un archivo del CDN de Meta. Nunca lanza: { ok:false, error } si no se pudo
 * (historia ya caducada, archivo enorme, red), para que el mensaje se guarde igual.
 */
async function downloadRemoteMedia(url) {
  if (!url || !/^https:\/\//i.test(url)) return { ok: false, error: 'Sin enlace al archivo.' };
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) return { ok: false, error: `Instagram no entregó el archivo (${response.status}).` };
    const declared = Number(response.headers.get('content-length')) || 0;
    if (declared > MAX_REMOTE_BYTES) return { ok: false, tooLarge: true, error: 'El archivo es demasiado grande para guardarlo.' };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return { ok: false, error: 'El archivo llegó vacío.' };
    if (buffer.length > MAX_REMOTE_BYTES) return { ok: false, tooLarge: true, error: 'El archivo es demasiado grande para guardarlo.' };
    const mimeType = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0];
    return { ok: true, buffer, mimeType, mediaType: mediaTypeFromMime(mimeType) };
  } catch (err) {
    return { ok: false, error: err?.name === 'TimeoutError' ? 'Instagram tardó demasiado en entregar el archivo.' : 'No se pudo descargar el archivo de Instagram.' };
  }
}

/**
 * Anuncio que llegó SIN mensaje (evento `messaging_referrals`: la persona tocó el
 * anuncio y abrió el chat pero aún no escribió). Se guarda unos minutos para
 * pegárselo a su primer mensaje; si no, la atribución se perdía.
 */
const PENDING_TTL_MS = 30 * 60 * 1000;
const pending = new Map();

function rememberReferral(senderId, event) {
  const ref = adReferralFrom(event?.referral);
  if (!senderId || !ref) return false;
  pending.set(String(senderId), { ref, at: Date.now() });
  return true;
}

function takePendingReferral(senderId) {
  const key = String(senderId || '');
  const hit = pending.get(key);
  if (!hit) return null;
  pending.delete(key);
  return Date.now() - hit.at <= PENDING_TTL_MS ? hit.ref : null;
}

module.exports = {
  parseInstagramEvent,
  downloadRemoteMedia,
  rememberReferral,
  takePendingReferral,
  MAX_REMOTE_BYTES,
};
