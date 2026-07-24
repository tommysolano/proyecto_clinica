const ChatGalleryImage = require('../models/ChatGalleryImage');
const { parseDataUrl } = require('../utils/dataUrl');

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
    const parsed = parseDataUrl(img.dataUrl);
    if (!parsed) return res.status(415).send('Unsupported');
    const contentType = parsed.mimeType || img.mimeType || 'application/octet-stream';
    const buffer = Buffer.from(parsed.b64, 'base64');

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Accept-Ranges', 'bytes');

    // Petición parcial (reproductores de audio/video): se devuelve el trozo pedido.
    const range = req.headers?.range;
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
  } catch (err) {
    return res.status(500).send('Error');
  }
};
