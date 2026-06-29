const crypto = require('crypto');
const BookingConfig = require('../models/BookingConfig');
const ChatGalleryImage = require('../models/ChatGalleryImage');

function genToken() {
  return crypto.randomBytes(9).toString('base64url'); // ~12 chars URL-safe
}

async function getOrCreate(clinicId, userId) {
  let cfg = await BookingConfig.findOne({ clinic: clinicId });
  if (!cfg) {
    cfg = await BookingConfig.create({ clinic: clinicId, token: genToken(), updatedBy: userId });
  } else if (!cfg.token) {
    cfg.token = genToken();
    await cfg.save();
  }
  return cfg;
}

exports.get = async (req, res) => {
  try {
    const cfg = await getOrCreate(req.clinicId, req.user._id);
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ message: 'Error al obtener configuración de reservas', error: err.message });
  }
};

exports.update = async (req, res) => {
  try {
    const cfg = await getOrCreate(req.clinicId, req.user._id);
    const allowed = [
      'enabled', 'days', 'hourFrom', 'hourTo', 'slotMinutes', 'maxPerSlot', 'horizonDays',
      'services', 'confirmationMessage',
      // Landing pública.
      'tagline', 'coverImageUrl', 'logoUrl', 'primaryColor', 'aboutTitle', 'about',
      'highlights', 'gallery', 'programsTitle', 'programs', 'addressText', 'phoneText', 'instagram',
    ];
    allowed.forEach((k) => {
      if (req.body[k] !== undefined) cfg[k] = req.body[k];
    });
    cfg.updatedBy = req.user._id;
    await cfg.save();
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ message: 'Error al guardar configuración de reservas', error: err.message });
  }
};

/**
 * Sube una imagen de la landing (portada, logo, galería o programa) como data
 * URL base64. La almacena en ChatGalleryImage (reutiliza el storage de la
 * galería) y devuelve su URL pública autoalojada (`/api/public/media/:id`),
 * que la página pública sirve sin autenticación.
 */
exports.uploadImage = async (req, res) => {
  try {
    const { dataUrl, name } = req.body;
    if (!dataUrl || !/^data:image\/(png|jpe?g|webp);base64,/.test(dataUrl)) {
      return res.status(400).json({ message: 'Imagen inválida (usa PNG/JPG/WEBP)' });
    }
    if (dataUrl.length > 2_500_000) {
      return res.status(400).json({ message: 'Imagen demasiado grande (máx ~1.8MB)' });
    }
    const mimeMatch = dataUrl.match(/^data:(image\/[a-zA-Z0-9+]+);/);
    const img = await ChatGalleryImage.create({
      clinic: req.clinicId,
      name: name || `booking_${Date.now()}`,
      dataUrl,
      mimeType: mimeMatch ? mimeMatch[1] : 'image/png',
      size: dataUrl.length,
      createdBy: req.user._id,
    });
    const base = process.env.PUBLIC_API_URL || '';
    const url = base ? `${base}/api/public/media/${img._id}` : `/api/public/media/${img._id}`;
    res.status(201).json({ id: img._id, url });
  } catch (err) {
    res.status(500).json({ message: 'Error al subir imagen', error: err.message });
  }
};

// Regenera el token (invalida el link anterior).
exports.regenerateToken = async (req, res) => {
  try {
    const cfg = await getOrCreate(req.clinicId, req.user._id);
    cfg.token = genToken();
    await cfg.save();
    res.json(cfg);
  } catch (err) {
    res.status(500).json({ message: 'Error al regenerar token', error: err.message });
  }
};
