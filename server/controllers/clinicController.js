const multer = require('multer');
const Clinic = require('../models/Clinic');
const User = require('../models/User');

// Subida de logo en memoria. Lo guardamos como data URL base64 en clinic.logoUrl
// para evitar dependencias de disco/CDN externos (entornos cloud con FS efímero).
const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (/^image\/(png|jpe?g|webp|svg\+xml)$/.test(file.mimetype)) return cb(null, true);
    cb(new Error('Formato no permitido. Usa PNG, JPG, WEBP o SVG.'));
  },
}).single('logo');

exports.logoUploadMiddleware = logoUpload;

exports.uploadLogo = async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      const role = req.user.getRoleForClinic(req.params.id);
      if (role !== 'admin') return res.status(403).json({ message: 'Sin permisos para subir logo' });
    }
    if (!req.file) return res.status(400).json({ message: 'Archivo requerido' });
    const dataUrl = `data:${req.file.mimetype};base64,${req.file.buffer.toString('base64')}`;
    const clinic = await Clinic.findByIdAndUpdate(
      req.params.id,
      { logoUrl: dataUrl },
      { new: true }
    );
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
    res.json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al subir logo', error: error.message });
  }
};

exports.removeLogo = async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      const role = req.user.getRoleForClinic(req.params.id);
      if (role !== 'admin') return res.status(403).json({ message: 'Sin permisos' });
    }
    const clinic = await Clinic.findByIdAndUpdate(
      req.params.id,
      { logoUrl: '' },
      { new: true }
    );
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
    res.json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al quitar logo', error: error.message });
  }
};

/**
 * Lista clínicas. Super-admin ve todas; resto solo las suyas.
 */
exports.getClinics = async (req, res) => {
  try {
    let clinics;
    if (req.user.isSuperAdmin) {
      clinics = await Clinic.find().sort({ createdAt: -1 });
    } else {
      const clinicIds = req.user.clinics.map((c) => c.clinic);
      clinics = await Clinic.find({ _id: { $in: clinicIds } }).sort({ createdAt: -1 });
    }
    res.json(clinics);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener clínicas', error: error.message });
  }
};

exports.getClinic = async (req, res) => {
  try {
    const clinic = await Clinic.findById(req.params.id);
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });

    if (!req.user.isSuperAdmin) {
      const role = req.user.getRoleForClinic(clinic._id);
      if (!role) return res.status(403).json({ message: 'Sin acceso a esta clínica' });
    }
    res.json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener clínica' });
  }
};

/**
 * Crear clínica. Solo super-admin.
 */
exports.createClinic = async (req, res) => {
  try {
    const clinic = await Clinic.create({ ...req.body, owner: req.user._id });

    // Auto-asignar al creador como admin
    await User.findByIdAndUpdate(req.user._id, {
      $push: { clinics: { clinic: clinic._id, role: 'admin' } },
    });

    res.status(201).json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear clínica', error: error.message });
  }
};

exports.updateClinic = async (req, res) => {
  try {
    if (!req.user.isSuperAdmin) {
      const role = req.user.getRoleForClinic(req.params.id);
      if (role !== 'admin') return res.status(403).json({ message: 'Sin permisos' });
    }
    const clinic = await Clinic.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
    res.json(clinic);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar clínica', error: error.message });
  }
};

exports.deleteClinic = async (req, res) => {
  try {
    const clinic = await Clinic.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    );
    if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
    res.json({ message: 'Clínica desactivada' });
  } catch (error) {
    res.status(500).json({ message: 'Error al desactivar clínica' });
  }
};
