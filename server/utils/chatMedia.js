/**
 * Almacén de los adjuntos del chat — FUERA del documento del mensaje.
 *
 * POR QUÉ EXISTE ESTE ARCHIVO
 * ---------------------------
 * Hasta ahora, la media que ENTRABA por WhatsApp (fotos, notas de voz, videos,
 * documentos) se guardaba como data URL base64 DENTRO del propio mensaje. Medido
 * en producción: 114 mensajes acumulaban 73 MB de los 83 MB de toda la colección,
 * y `GET /chats/:id/messages` devolvía esos bytes al navegador en CADA apertura
 * del chat. Una conversación de 16 mensajes con un solo video pesaba 6.8 MB de
 * JSON: el chat tardaba una eternidad en abrir y a menudo directamente fallaba
 * ("Error al cargar mensajes"), dejando al call center sin poder atender.
 *
 * Ahora los bytes se guardan UNA vez en ChatGalleryImage y el mensaje solo lleva
 * la URL pública (`/api/public/media/:id`). Eso cambia el chat de "descargar 6.8 MB
 * de JSON antes de pintar nada" a "pintar el texto al instante y que el navegador
 * cargue el video aparte, con caché y peticiones por rango" — que es exactamente
 * como se comporta WhatsApp Web.
 */

const { parseDataUrl } = require('./dataUrl');

/** ¿Es un data URL inline (los bytes viajan dentro del propio campo)? */
function isInlineDataUrl(url) {
  return typeof url === 'string' && url.startsWith('data:');
}

/**
 * URL pública de un adjunto ya almacenado. Relativa a propósito cuando no hay
 * PUBLIC_API_URL: el frontend se sirve desde el mismo origen que la API, y el
 * gateway QR localiza el adjunto por el id de la ruta (no necesita el host).
 * Meta sí necesita URL absoluta, pero solo para las cabeceras de plantilla, que
 * siguen construyéndose con `publicMediaUrl(req, id)` en el controlador.
 */
function mediaUrlForId(id) {
  const base = String(process.env.PUBLIC_API_URL || '')
    .replace(/\/+$/, '')
    .replace(/\/api$/, '');
  return `${base}/api/public/media/${id}`;
}

/**
 * Guarda los bytes de un data URL en el almacén y devuelve su URL pública.
 * Devuelve `null` si el data URL no se puede parsear (el llamador decide qué
 * hacer: normalmente conservar el original antes que perder el archivo).
 *
 * `kind` separa los usos que comparten colección:
 *   - 'gallery'    → la galería que el agente elige a mano (uploadGallery)
 *   - 'attachment' → adjunto subido para enviar (mensajes guardados, composer)
 *   - 'inbound'    → lo que MANDA el contacto; nunca debe aparecer en la galería
 */
async function storeInlineMedia({ clinicId, dataUrl, name, kind = 'inbound', createdBy = null }) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  const ChatGalleryImage = require('../models/ChatGalleryImage');
  const doc = await ChatGalleryImage.create({
    clinic: clinicId,
    name: String(name || `adjunto_${Date.now()}`).slice(0, 200),
    dataUrl,
    mimeType: parsed.mimeType || 'application/octet-stream',
    size: Buffer.byteLength(parsed.b64, 'utf8'),
    kind,
    ...(createdBy ? { createdBy } : {}),
  });
  return { id: doc._id, url: mediaUrlForId(doc._id), size: doc.size };
}

/**
 * Si `dataUrl` es inline lo mueve al almacén y devuelve su URL pública; si ya es
 * una URL la devuelve tal cual. Nunca lanza: ante un fallo del almacén se
 * devuelve el valor original — es preferible un mensaje pesado a perder la foto
 * o la nota de voz de un paciente.
 */
async function externalizeMedia({ clinicId, dataUrl, name, kind = 'inbound', createdBy = null }) {
  if (!isInlineDataUrl(dataUrl)) return { url: dataUrl || null, size: 0 };
  try {
    const stored = await storeInlineMedia({ clinicId, dataUrl, name, kind, createdBy });
    if (stored) return stored;
  } catch (err) {
    console.error('[chatMedia] no se pudo externalizar el adjunto: %s', err.message);
  }
  return { url: dataUrl, size: 0 };
}

/**
 * Copia del mensaje apta para viajar por socket.io. Un mensaje con media inline
 * (los que quedan de antes de la migración) pesa MEGAS, y `emitToCallCenter` lo
 * difunde a TODAS las pestañas del call center a la vez: un solo audio de 7 MB
 * congelaba las cinco pantallas del equipo. El adjunto se pide aparte por su URL.
 */
function sanitizeMessageForSocket(msg) {
  if (!msg) return msg;
  const plain = typeof msg.toObject === 'function' ? msg.toObject() : { ...msg };
  if (isInlineDataUrl(plain.mediaUrl)) {
    plain.mediaUrl = legacyInlineMediaUrl(plain._id);
  }
  return plain;
}

/**
 * URL desde la que se sirve un adjunto que TODAVÍA está inline dentro del mensaje
 * (los anteriores a la migración). Va por la ruta pública, igual que el resto de
 * adjuntos del chat: un `<img>`/`<video>` no manda la cabecera Authorization, así
 * que una ruta autenticada no podría pintarlos. Mismo modelo que
 * `/api/public/media/:id`: el ObjectId es la clave opaca.
 * Ver `mediaController.serveMessageMedia`.
 */
function legacyInlineMediaUrl(messageId) {
  return `/api/public/message-media/${messageId}`;
}

module.exports = {
  externalizeMedia,
  isInlineDataUrl,
  legacyInlineMediaUrl,
  mediaUrlForId,
  sanitizeMessageForSocket,
  storeInlineMedia,
};
