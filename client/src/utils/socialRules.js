/**
 * Reglas de las redes para el planificador (copia para el editor).
 *
 * La que MANDA es la del servidor (server/utils/social/rules.js): se valida otra
 * vez al programar y antes de publicar. Esta copia solo sirve para avisar
 * mientras se escribe; si se cambia una regla, cambiarla en los dos sitios.
 */
import { ecDayKey, fmtTimeEc } from './date';

export const NETWORKS = ['instagram', 'facebook', 'tiktok', 'youtube'];

export const NETWORK_LABELS = { facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok', youtube: 'YouTube' };

export const FORMAT_LABELS = {
  post: 'Publicación', carousel: 'Carrusel', reel: 'Reel', story: 'Historia',
  video: 'Video', short: 'Short', photo: 'Fotos',
};

export const FORMATS_BY_NETWORK = {
  facebook: ['post', 'reel', 'story'],
  instagram: ['post', 'carousel', 'reel', 'story'],
  tiktok: ['video', 'photo'],
  youtube: ['video', 'short'],
};

export const LIMITS = {
  instagramCaption: 2200,
  instagramHashtags: 30,
  tiktokVideoCaption: 2200,
  tiktokPhotoTitle: 90,
  tiktokPhotoDescription: 4000,
  youtubeTitle: 100,
  youtubeDescription: 5000,
};

export const STATUS_META = {
  draft: { label: 'Borrador', badge: 'badge-neutral', dot: 'bg-slate-400' },
  in_review: { label: 'En revisión', badge: 'badge-warning', dot: 'bg-amber-500' },
  scheduled: { label: 'Programada', badge: 'badge-info', dot: 'bg-sky-500' },
  publishing: { label: 'Publicando', badge: 'badge-info', dot: 'bg-indigo-500' },
  needs_action: { label: 'Publicar a mano', badge: 'badge-warning', dot: 'bg-orange-500' },
  published: { label: 'Publicada', badge: 'badge-success', dot: 'bg-emerald-500' },
  partial: { label: 'Parcial', badge: 'badge-warning', dot: 'bg-amber-600' },
  failed: { label: 'Falló', badge: 'badge-danger', dot: 'bg-rose-500' },
  cancelled: { label: 'Cancelada', badge: 'badge-neutral', dot: 'bg-slate-300' },
};

export const TARGET_STATUS_META = {
  pending: { label: 'Pendiente', badge: 'badge-neutral' },
  processing: { label: 'Procesando en la red', badge: 'badge-info' },
  published: { label: 'Publicado', badge: 'badge-success' },
  failed: { label: 'Falló', badge: 'badge-danger' },
  manual_due: { label: 'Toca publicar a mano', badge: 'badge-warning' },
  skipped: { label: 'Omitido', badge: 'badge-neutral' },
};

export const TIKTOK_PRIVACY_LABELS = {
  PUBLIC_TO_EVERYONE: 'Todos',
  MUTUAL_FOLLOW_FRIENDS: 'Amigos (se siguen mutuamente)',
  FOLLOWER_OF_CREATOR: 'Seguidores',
  SELF_ONLY: 'Solo yo',
};

export const YOUTUBE_CATEGORIES = [
  { id: '22', label: 'Personas y blogs' },
  { id: '26', label: 'Consejos y estilo' },
  { id: '27', label: 'Educación' },
  { id: '24', label: 'Entretenimiento' },
  { id: '28', label: 'Ciencia y tecnología' },
  { id: '17', label: 'Deportes' },
  { id: '29', label: 'ONG y activismo' },
];

export const isVideo = (m) => String(m?.mimeType || '').startsWith('video/');
export const isImage = (m) => String(m?.mimeType || '').startsWith('image/');

export function normalizeHashtags(list) {
  const out = [];
  const seen = new Set();
  for (const raw of list || []) {
    const clean = String(raw || '').trim().replace(/^#+/, '').replace(/\s+/g, '').replace(/[^\p{L}\p{N}_]/gu, '');
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(`#${clean}`);
  }
  return out;
}

export function composeText(post, target, { includeLink = true } = {}) {
  const base = String(target?.caption || '').trim() || String(post?.caption || '').trim();
  const link = includeLink ? String(post?.link || '').trim() : '';
  const tags = normalizeHashtags(post?.hashtags).join(' ');
  return [base, link, tags].filter(Boolean).join('\n\n');
}

/** Formato por defecto al agregar un destino, según los medios que ya hay. */
export function defaultFormat(network, media = []) {
  const videos = media.filter(isVideo).length;
  const images = media.filter(isImage).length;
  if (network === 'instagram') return videos === 1 && media.length === 1 ? 'reel' : media.length > 1 ? 'carousel' : 'post';
  if (network === 'facebook') return videos === 1 && media.length === 1 ? 'reel' : 'post';
  if (network === 'tiktok') return images && !videos ? 'photo' : 'video';
  if (network === 'youtube') {
    const v = media.find(isVideo);
    return v && v.height > v.width && (!v.duration || v.duration <= 180) ? 'short' : 'video';
  }
  return FORMATS_BY_NETWORK[network][0];
}

/** Avisos del editor para un destino (mismo criterio que el servidor). */
export function targetWarnings(post, t, account, tiktokInfo) {
  const w = [];
  if (t.mode === 'manual') return w;
  const media = post.media || [];
  const videos = media.filter(isVideo);
  const images = media.filter(isImage);
  const text = composeText(post, t, { includeLink: !(t.network === 'facebook' && t.format === 'post' && !media.length) });
  if (!account) w.push('Elige la cuenta (o pásalo a «publicar a mano»)');
  if (account?.status === 'error') w.push('La conexión de esta cuenta falló: vuelve a conectarla');

  if (t.network === 'instagram') {
    if (t.format === 'post' && media.length !== 1) w.push('Lleva exactamente 1 imagen o 1 video (para varias usa Carrusel)');
    if (t.format === 'carousel' && (media.length < 2 || media.length > 10)) w.push('El carrusel lleva de 2 a 10 elementos');
    if (t.format === 'reel' && (media.length !== 1 || !videos.length)) w.push('El reel lleva exactamente 1 video');
    if (t.format === 'story' && media.length !== 1) w.push('La historia lleva exactamente 1 imagen o 1 video');
    if (t.format === 'story' && videos[0]?.duration > 60) w.push('La historia en video dura como máximo 60 s');
    if (t.format === 'reel' && videos[0]?.duration && (videos[0].duration < 3 || videos[0].duration > 900)) w.push('El reel dura entre 3 s y 15 min');
    if (t.format !== 'story' && text.length > LIMITS.instagramCaption) w.push(`El texto pasa de ${LIMITS.instagramCaption} caracteres`);
    if (normalizeHashtags(post.hashtags).length > LIMITS.instagramHashtags) w.push(`Máximo ${LIMITS.instagramHashtags} hashtags`);
    if (t.format === 'post' || t.format === 'carousel') {
      const bad = images.find((m) => m.width && m.height && (m.width / m.height < 0.8 || m.width / m.height > 1.91));
      if (bad) w.push('Instagram exige proporción entre 4:5 (vertical) y 1.91:1 (horizontal) en el feed');
    }
    if (t.format === 'story' && post.link) w.push('Las historias por API no llevan sticker de enlace: si lo necesitas, usa «publicar a mano»');
  }
  if (t.network === 'facebook') {
    if (t.format === 'post' && videos.length && media.length > 1) w.push('Un video va solo (no se mezcla con fotos)');
    if (t.format === 'post' && images.length > 10) w.push('Máximo 10 fotos');
    if (t.format === 'post' && !media.length && !text.trim() && !post.link) w.push('Escribe un texto o agrega un enlace o un medio');
    if (t.format === 'reel' && (media.length !== 1 || !videos.length)) w.push('El reel lleva exactamente 1 video');
    if (t.format === 'reel' && videos[0]?.duration && (videos[0].duration < 3 || videos[0].duration > 90)) w.push('El reel de Facebook dura entre 3 y 90 s');
    if (t.format === 'story' && media.length !== 1) w.push('La historia lleva exactamente 1 imagen o 1 video');
    if (t.format === 'story' && videos[0]?.duration && (videos[0].duration < 3 || videos[0].duration > 60)) w.push('La historia en video dura entre 3 y 60 s');
  }
  if (t.network === 'tiktok') {
    const o = t.options || {};
    if (t.format === 'video' && (media.length !== 1 || !videos.length)) w.push('Lleva exactamente 1 video');
    if (t.format === 'photo' && (!images.length || videos.length || images.length > 35)) w.push('Lleva de 1 a 35 fotos (sin videos)');
    if (t.format === 'photo' && String(t.title || '').length > LIMITS.tiktokPhotoTitle) w.push(`El título pasa de ${LIMITS.tiktokPhotoTitle} caracteres`);
    if (t.format === 'video' && text.length > LIMITS.tiktokVideoCaption) w.push(`El texto pasa de ${LIMITS.tiktokVideoCaption} caracteres`);
    if ((o.postMode || 'direct') === 'direct') {
      if (!o.privacyLevel) w.push('Elige quién puede verlo');
      if (o.brandContent && o.privacyLevel === 'SELF_ONLY') w.push('El contenido de marca no puede ser privado');
      if (o.commercial && !o.brandContent && !o.brandOrganic) w.push('Marca «Tu marca» o «Contenido de marca»');
    }
    if (t.format === 'photo' && o.postMode === 'inbox') w.push('Las fotos solo se pueden publicar directo');
    const max = tiktokInfo?.maxVideoPostDurationSec;
    if (max && videos[0]?.duration > max) w.push(`Esta cuenta admite videos de hasta ${max} s`);
  }
  if (t.network === 'youtube') {
    const o = t.options || {};
    if (media.length !== 1 || !videos.length) w.push('Lleva exactamente 1 video');
    if (!String(t.title || post.title || '').trim()) w.push('El título es obligatorio');
    if (String(t.title || '').length > LIMITS.youtubeTitle) w.push(`El título pasa de ${LIMITS.youtubeTitle} caracteres`);
    if (typeof o.madeForKids !== 'boolean') w.push('Indica si es «creado para niños»');
    if (t.format === 'short' && videos[0]?.duration > 180) w.push('Un Short dura como máximo 3 minutos');
  }
  return w;
}

/** 'YYYY-MM-DDTHH:mm' en hora de Ecuador para el DateTimeInput. */
export function toEcInput(iso) {
  if (!iso) return '';
  return `${ecDayKey(iso)}T${fmtTimeEc(iso)}`;
}

/** Inversa: el valor del DateTimeInput (hora de Ecuador, UTC-5 sin horario de verano) a ISO. */
export function fromEcInput(value) {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(`${value}:00-05:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
