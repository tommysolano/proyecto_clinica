const ChatGalleryImage = require('../models/ChatGalleryImage');

/**
 * Sirve públicamente (sin auth) una imagen de la galería por su id, decodificando
 * el data URL base64 a bytes. Permite que Meta consuma imágenes de cabecera de
 * plantilla por URL pública (`${PUBLIC_API_URL}/api/public/media/:id`), ya que la
 * Cloud API no acepta data URLs.
 */
exports.serve = async (req, res) => {
  try {
    const img = await ChatGalleryImage.findById(req.params.id).select('dataUrl mimeType');
    if (!img || !img.dataUrl) return res.status(404).send('Not found');
    const m = img.dataUrl.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) return res.status(415).send('Unsupported');
    const contentType = m[1] || img.mimeType || 'application/octet-stream';
    const buffer = Buffer.from(m[2], 'base64');
    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    res.set('Content-Length', String(buffer.length));
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error');
  }
};
