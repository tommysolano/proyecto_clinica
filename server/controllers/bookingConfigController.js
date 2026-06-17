const crypto = require('crypto');
const BookingConfig = require('../models/BookingConfig');

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
    const allowed = ['enabled', 'days', 'hourFrom', 'hourTo', 'slotMinutes', 'maxPerSlot', 'horizonDays', 'services', 'confirmationMessage'];
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
