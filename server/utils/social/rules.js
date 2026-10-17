/**
 * Reglas de cada red: qué formatos admite, qué medios lleva cada formato, límites
 * de texto, y cómo se arma el texto final (texto + enlace + hashtags).
 *
 * El cliente tiene una copia de los límites (client/src/utils/socialRules.js)
 * para avisar mientras se escribe; ESTA es la que manda: se valida al programar
 * y otra vez justo antes de publicar.
 */

const NETWORK_LABELS = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };
const FORMAT_LABELS = {
  post: 'Publicación', carousel: 'Carrusel', reel: 'Reel', story: 'Historia',
  video: 'Video', short: 'Short', photo: 'Fotos',
};

const FORMATS_BY_NETWORK = {
  facebook: ['post', 'reel', 'story'],
  instagram: ['post', 'carousel', 'reel', 'story'],
  tiktok: ['video', 'photo'],
  youtube: ['video', 'short'],
};

const LIMITS = {
  instagramCaption: 2200,
  instagramHashtags: 30,
  facebookText: 63206,
  tiktokVideoCaption: 2200,
  tiktokPhotoTitle: 90,
  tiktokPhotoDescription: 4000,
  youtubeTitle: 100,
  youtubeDescription: 5000,
};

const isVideo = (m) => String(m?.mimeType || '').startsWith('video/');
const isImage = (m) => String(m?.mimeType || '').startsWith('image/');

/** '#Salud', 'salud', '#salud natural' → '#salud', '#saludnatural'… sin repetidos. */
function normalizeHashtags(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const clean = String(raw || '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, '')
      .replace(/[^\p{L}\p{N}_]/gu, '');
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${clean}`);
  }
  return out;
}

/**
 * Texto final de un destino: su texto propio (o el general) + enlace + hashtags.
 * `includeLink: false` cuando el enlace viaja aparte (post de solo texto en
 * Facebook, que lo convierte en tarjeta de vista previa).
 */
function composeText(post, target, { includeLink = true } = {}) {
  const base = String(target?.caption || '').trim() || String(post?.caption || '').trim();
  const link = includeLink ? String(post?.link || '').trim() : '';
  const tags = normalizeHashtags(post?.hashtags).join(' ');
  return [base, link, tags].filter(Boolean).join('\n\n');
}

/** YouTube rechaza `<` y `>` en título y descripción. */
const youtubeSafe = (s) => String(s || '').replace(/[<>]/g, '');

function youtubeTitle(post, target) {
  return youtubeSafe(String(target?.title || '').trim() || post?.title || '').slice(0, LIMITS.youtubeTitle);
}

/**
 * Errores que impiden publicar un destino (array de textos; vacío = OK).
 * `account` es el SocialAccount (o null). Los destinos manuales no exigen
 * cuenta ni medios válidos para la API: los sube una persona.
 */
function validateTarget(post, target, account) {
  const errs = [];
  const net = target.network;
  const label = `${NETWORK_LABELS[net] || net} · ${FORMAT_LABELS[target.format] || target.format}`;
  const add = (m) => errs.push(`${label}: ${m}`);

  if (!FORMATS_BY_NETWORK[net]?.includes(target.format)) {
    add('formato no disponible en esta red');
    return errs;
  }
  if (target.mode === 'manual') return errs;

  // Canción de la biblioteca de la red: ninguna API oficial deja elegirla. Solo
  // se puede publicando a mano o mandando el video a borradores de TikTok.
  if (post.music?.mode === 'app' && !(net === 'tiktok' && target.options?.postMode === 'inbox')) {
    add('la música de la app solo se elige publicando a mano (o en borradores de TikTok); pásalo a «publicar a mano» o sube tu propio audio');
  }

  if (!account) add('elige la cuenta donde se publica (o pásalo a «publicar a mano»)');
  else if (account.network !== net) add('la cuenta elegida es de otra red');

  const media = post.media || [];
  const videos = media.filter(isVideo);
  const images = media.filter(isImage);
  const text = composeText(post, target, { includeLink: !(net === 'facebook' && target.format === 'post' && !media.length) });
  const MB = 1024 * 1024;
  const pesaMas = (list, mb) => list.some((m) => (m.size || 0) > mb * MB);

  if (net === 'instagram') {
    if (images.some((m) => !/^image\/jpe?g$/i.test(m.mimeType))) add('Instagram solo acepta imágenes JPG');
    if (pesaMas(images, 8)) add('cada imagen pesa como máximo 8 MB');
    if (target.format === 'story' ? pesaMas(videos, 100) : pesaMas(videos, 300)) {
      add(target.format === 'story' ? 'el video de la historia pesa como máximo 100 MB' : 'el video pesa como máximo 300 MB');
    }
    if (target.format === 'post' && media.length !== 1) add('lleva exactamente 1 imagen o 1 video (para varias usa Carrusel)');
    if (target.format === 'carousel' && (media.length < 2 || media.length > 10)) add('el carrusel lleva de 2 a 10 imágenes o videos');
    if (target.format === 'reel' && (media.length !== 1 || !videos.length)) add('el reel lleva exactamente 1 video');
    if (target.format === 'story' && media.length !== 1) add('la historia lleva exactamente 1 imagen o 1 video');
    if (target.format === 'reel' && videos[0]?.duration && (videos[0].duration < 3 || videos[0].duration > 900)) add('el reel debe durar entre 3 segundos y 15 minutos');
    if (target.format === 'story' && videos[0]?.duration > 60) add('la historia en video dura como máximo 60 segundos');
    if (target.format !== 'story' && text.length > LIMITS.instagramCaption) add(`el texto pasa de ${LIMITS.instagramCaption} caracteres`);
    if (normalizeHashtags(post.hashtags).length > LIMITS.instagramHashtags) add(`máximo ${LIMITS.instagramHashtags} hashtags`);
  }

  if (net === 'facebook') {
    if (pesaMas(images, 4)) add('Facebook acepta fotos de hasta 4 MB');
    if (target.format === 'post') {
      if (videos.length && media.length > 1) add('un video va solo (no se mezcla con fotos)');
      if (images.length > 10) add('máximo 10 fotos');
      if (!media.length && !text.trim() && !post.link) add('escribe un texto o agrega un enlace o un medio');
    }
    if (target.format === 'reel' && (media.length !== 1 || !videos.length)) add('el reel lleva exactamente 1 video');
    if (target.format === 'reel' && videos[0]?.duration && (videos[0].duration < 3 || videos[0].duration > 90)) add('el reel de Facebook dura entre 3 y 90 segundos');
    if (target.format === 'story' && media.length !== 1) add('la historia lleva exactamente 1 imagen o 1 video');
    if (target.format === 'story' && videos[0]?.duration && (videos[0].duration < 3 || videos[0].duration > 60)) add('la historia en video dura entre 3 y 60 segundos');
    if (text.length > LIMITS.facebookText) add('el texto es demasiado largo');
  }

  if (net === 'tiktok') {
    const o = target.options || {};
    if (target.format === 'video' && (media.length !== 1 || !videos.length)) add('lleva exactamente 1 video');
    if (target.format === 'photo') {
      if (!images.length || videos.length) add('lleva de 1 a 35 fotos (sin videos)');
      if (images.length > 35) add('máximo 35 fotos');
      if (String(target.title || '').length > LIMITS.tiktokPhotoTitle) add(`el título pasa de ${LIMITS.tiktokPhotoTitle} caracteres`);
      if (text.length > LIMITS.tiktokPhotoDescription) add(`la descripción pasa de ${LIMITS.tiktokPhotoDescription} caracteres`);
    } else if (text.length > LIMITS.tiktokVideoCaption) {
      add(`el texto pasa de ${LIMITS.tiktokVideoCaption} caracteres`);
    }
    // Reglas de TikTok para «publicación directa»: la privacidad la elige la
    // persona (sin valor por defecto) y el contenido de marca no puede ser privado.
    if ((o.postMode || 'direct') === 'direct') {
      if (!o.privacyLevel) add('elige quién puede verlo (TikTok exige que se elija, sin valor por defecto)');
      if (o.brandContent && o.privacyLevel === 'SELF_ONLY') add('el contenido de marca no puede ser privado');
      if (o.commercial && !o.brandContent && !o.brandOrganic) add('marca «Tu marca» o «Contenido de marca», o desactiva la divulgación comercial');
    }
    if (target.format === 'photo' && o.postMode === 'inbox') add('las fotos solo se pueden publicar directo');
  }

  if (net === 'youtube') {
    const o = target.options || {};
    if (media.length !== 1 || !videos.length) add('lleva exactamente 1 video');
    if (!youtubeTitle(post, target)) add('el título es obligatorio');
    if (String(target.title || '').length > LIMITS.youtubeTitle) add(`el título pasa de ${LIMITS.youtubeTitle} caracteres`);
    if (youtubeSafe(text).length > LIMITS.youtubeDescription) add(`la descripción pasa de ${LIMITS.youtubeDescription} caracteres`);
    if (typeof o.madeForKids !== 'boolean') add('indica si el video es «creado para niños» (YouTube lo exige)');
    if (target.format === 'short' && videos[0]?.duration > 180) add('un Short dura como máximo 3 minutos');
  }

  return errs;
}

module.exports = {
  FORMATS_BY_NETWORK,
  FORMAT_LABELS,
  LIMITS,
  NETWORK_LABELS,
  composeText,
  isImage,
  isVideo,
  normalizeHashtags,
  validateTarget,
  youtubeSafe,
  youtubeTitle,
};
