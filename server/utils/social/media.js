/**
 * Acceso a los medios de una publicación para las redes.
 *
 * Los archivos viven en el disco del servidor (utils/mediaStore) como
 * ChatGalleryImage de tipo 'social'. Hay dos formas de dárselos a una red:
 *   - Meta (Facebook/Instagram) los DESCARGA de una URL pública:
 *     `/api/public/media/:id`, la misma que ya usa WhatsApp.
 *   - TikTok y YouTube reciben los bytes: se suben por stream desde el disco.
 */
const { SocialApiError } = require('./http');
const { apiBase } = require('./oauth');

function publicMediaUrl(mediaId) {
  return `${apiBase()}/public/media/${mediaId}`;
}

/** Ruta en disco, tamaño y tipo de un medio. Lanza si el archivo no está. */
async function mediaFile(mediaId) {
  const ChatGalleryImage = require('../../models/ChatGalleryImage');
  const mediaStore = require('../mediaStore');
  const doc = await ChatGalleryImage.findById(mediaId).select('storageKey mimeType name').lean();
  if (!doc?.storageKey) throw new SocialApiError('No se encontró el archivo del medio en el servidor');
  const size = await mediaStore.size(doc.storageKey);
  if (size == null) throw new SocialApiError('Falta el archivo del medio en el disco del servidor');
  return { path: mediaStore.absolutePath(doc.storageKey), size, mimeType: doc.mimeType || 'application/octet-stream', name: doc.name || '' };
}

module.exports = { mediaFile, publicMediaUrl };
