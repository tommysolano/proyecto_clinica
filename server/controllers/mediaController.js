const ChatGalleryImage = require('../models/ChatGalleryImage');
const { parseDataUrl } = require('../utils/dataUrl');

/**
 * Responde con los bytes de un data URL, atendiendo peticiones con `Range`
 * (206 Parcial): Safari/iOS NO reproduce audio ni video servido por URL si el
 * servidor no soporta rangos.
 */
function sendDataUrl(res, dataUrl, { fallbackMime = 'application/octet-stream', cache, range } = {}) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return res.status(415).send('Unsupported');
  const buffer = Buffer.from(parsed.b64, 'base64');

  res.set('Content-Type', parsed.mimeType || fallbackMime);
  res.set('Cache-Control', cache || 'public, max-age=31536000, immutable');
  res.set('Accept-Ranges', 'bytes');

  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), buffer.length - 1) : buffer.length - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= buffer.length) {
      res.set('Content-Range', `bytes */${buffer.length}`);
      return res.status(416).end();
    }
    const chunk = buffer.subarray(start, end + 1);
    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
    res.set('Content-Length', String(chunk.length));
    return res.send(chunk);
  }

  res.set('Content-Length', String(buffer.length));
  return res.send(buffer);
}

/**
 * GET /api/public/message-media/:messageId — adjunto de un mensaje que TODAVÍA lo
 * guarda inline (los anteriores a la migración a `utils/chatMedia`). Gracias a
 * esto el hilo puede devolverse sin los megas de base64 sin que esos mensajes
 * pierdan su foto, su nota de voz o su video. Tras correr
 * `migrateChatMediaToStorage.js --commit` deja de recibir tráfico, pero se
 * mantiene por si queda alguno suelto.
 */
exports.serveMessageMedia = async (req, res) => {
  try {
    const Message = require('../models/Message');
    const msg = await Message.findById(req.params.messageId).select('mediaUrl').lean();
    if (!msg?.mediaUrl) return res.status(404).send('Not found');
    // Ya migrado: se redirige a su URL definitiva (cacheable por el navegador).
    if (!msg.mediaUrl.startsWith('data:')) return res.redirect(302, msg.mediaUrl);
    return sendDataUrl(res, msg.mediaUrl, { cache: 'private, max-age=86400', range: req.headers?.range });
  } catch (err) {
    return res.status(500).send('Error');
  }
};

/**
 * Sirve públicamente (sin auth) un adjunto del chat por su id, decodificando el
 * data URL base64 a bytes. Lo consumen:
 *   - el <img>/<audio>/<video> del chat y de la galería,
 *   - Meta, para las cabeceras de imagen de plantilla (la Cloud API no acepta
 *     data URLs, necesita una URL pública).
 *
 * OJO con el parseo de la cabecera: el navegador incluye el CODEC en el tipo al
 * grabar audio (Firefox produce `audio/ogg;codecs=opus`), así que el data URL
 * guardado puede ser `data:audio/ogg;codecs=opus;base64,…`. El patrón antiguo
 * `^data:([^;]+);base64,` NO casaba con eso y devolvía 415: las notas de voz
 * grabadas en Firefox no se podían escuchar en el chat, y Meta las rechazaba con
 * el error 131053 ("Media upload error") al bajarlas por link. Se usa
 * `parseDataUrl`, que parte por el marcador `;base64,` (lo único garantizado).
 *
 * Se responde a peticiones con `Range` (206 Parcial): Safari/iOS NO reproduce
 * audio ni video servido por URL si el servidor no soporta rangos.
 */
exports.serve = async (req, res) => {
  try {
    const img = await ChatGalleryImage.findById(req.params.id).select('dataUrl mimeType name');
    if (!img || !img.dataUrl) return res.status(404).send('Not found');
    return sendDataUrl(res, img.dataUrl, {
      fallbackMime: img.mimeType || 'application/octet-stream',
      range: req.headers?.range,
    });
  } catch (err) {
    return res.status(500).send('Error');
  }
};
