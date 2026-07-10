const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { validationResult } = require('express-validator');
const User = require('../models/User');
const Clinic = require('../models/Clinic');
const { isAccessBlocked, blockMessage } = require('../utils/accessControl');

const ACCESS_EXPIRES = process.env.JWT_EXPIRES_IN || '8h';

const signToken = (payload) =>
  jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: ACCESS_EXPIRES });

const buildPublicUser = (user, activeClinic = null, role = null) => ({
  id: user._id,
  // También como _id: el frontend usa user._id en varios sitios (SocketContext,
  // Chats, Comisiones); sin este campo el socket nunca se conectaba.
  _id: user._id,
  name: user.name,
  email: user.email,
  isSuperAdmin: !!user.isSuperAdmin,
  specialty: user.specialty,
  cedula: user.cedula,
  phone: user.phone,
  clinics: user.clinics || [],
  activeClinic,
  role,
});

/**
 * Cambia la contraseña del usuario autenticado.
 */
exports.changePassword = async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ message: 'La nueva contraseña debe tener al menos 6 caracteres' });
    }
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });

    const ok = await bcrypt.compare(currentPassword || '', user.password);
    if (!ok) return res.status(400).json({ message: 'La contraseña actual es incorrecta' });

    user.password = await bcrypt.hash(newPassword, 12);
    await user.save();
    res.json({ message: 'Contraseña actualizada correctamente' });
  } catch (error) {
    res.status(500).json({ message: 'Error al cambiar contraseña', error: error.message });
  }
};

/**
 * Login: devuelve token sin clínica + lista de clínicas disponibles.
 * El cliente debe llamar a /auth/select-clinic para obtener un token con clinicId.
 */
exports.login = async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user || !user.active) {
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: 'Credenciales inválidas' });
    }

    // Bloqueo de acceso al sistema (super-admin y exceptuados quedan libres).
    const block = await isAccessBlocked(user);
    if (block.blocked) {
      return res.status(403).json({ message: blockMessage(block.rule), code: 'ACCESS_BLOCKED' });
    }

    const clinicIds = user.clinics.map((c) => c.clinic);
    const clinics = await Clinic.find({ _id: { $in: clinicIds }, active: true }).select(
      'name razonSocial nombreComercial'
    );

    // Mapear clínicas con su rol
    const clinicsWithRole = user.clinics
      .map((c) => {
        const clinic = clinics.find((cl) => String(cl._id) === String(c.clinic));
        return clinic ? { clinic, role: c.role } : null;
      })
      .filter(Boolean);

    // Si super-admin sin clínicas asignadas, listar todas
    let availableClinics = clinicsWithRole;
    if (user.isSuperAdmin) {
      const allClinics = await Clinic.find({ active: true }).select(
        'name razonSocial nombreComercial'
      );
      availableClinics = allClinics.map((clinic) => {
        const existing = clinicsWithRole.find((c) => String(c.clinic._id) === String(clinic._id));
        return existing || { clinic, role: 'admin' };
      });
    }

    // Token "preliminar" sin clinicId (solo permite seleccionar)
    const token = signToken({ id: user._id });

    // Aplanar lista para el frontend
    const flatClinics = availableClinics.map(({ clinic, role }) => ({
      _id: clinic._id,
      name: clinic.name,
      razonSocial: clinic.razonSocial,
      nombreComercial: clinic.nombreComercial,
      role,
    }));

    res.json({
      token,
      user: buildPublicUser(user),
      clinics: flatClinics,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor', error: error.message });
  }
};

/**
 * Selecciona la clínica activa y devuelve un nuevo JWT con clinicId.
 */
exports.selectClinic = async (req, res) => {
  try {
    const { clinicId } = req.body;
    if (!clinicId) return res.status(400).json({ message: 'clinicId requerido' });

    const user = req.user;
    let role = user.getRoleForClinic(clinicId);
    if (!role && user.isSuperAdmin) role = 'admin';
    if (!role) return res.status(403).json({ message: 'No tienes acceso a esta clínica' });

    const clinic = await Clinic.findById(clinicId);
    if (!clinic || !clinic.active) {
      return res.status(404).json({ message: 'Clínica no encontrada o inactiva' });
    }

    const token = signToken({ id: user._id, clinicId, role });

    res.json({
      token,
      user: buildPublicUser(user, clinic, role),
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor', error: error.message });
  }
};

exports.getMe = async (req, res) => {
  try {
    let activeClinic = null;
    if (req.clinicId) {
      activeClinic = await Clinic.findById(req.clinicId).select(
        'name razonSocial nombreComercial logoUrl'
      );
    }

    // Lista plana de clínicas accesibles (igual que en login)
    const clinicIds = req.user.clinics.map((c) => c.clinic);
    let clinicsDocs = await Clinic.find({ _id: { $in: clinicIds }, active: true }).select(
      'name razonSocial nombreComercial'
    );
    let flatClinics = req.user.clinics
      .map((c) => {
        const clinic = clinicsDocs.find((cl) => String(cl._id) === String(c.clinic));
        return clinic
          ? {
              _id: clinic._id,
              name: clinic.name,
              razonSocial: clinic.razonSocial,
              nombreComercial: clinic.nombreComercial,
              role: c.role,
            }
          : null;
      })
      .filter(Boolean);
    if (req.user.isSuperAdmin) {
      const all = await Clinic.find({ active: true }).select(
        'name razonSocial nombreComercial'
      );
      flatClinics = all.map((clinic) => {
        const ex = flatClinics.find((c) => String(c._id) === String(clinic._id));
        return (
          ex || {
            _id: clinic._id,
            name: clinic.name,
            razonSocial: clinic.razonSocial,
            nombreComercial: clinic.nombreComercial,
            role: 'admin',
          }
        );
      });
    }

    res.json({
      user: buildPublicUser(req.user, activeClinic, req.role),
      activeClinic,
      role: req.role || null,
      clinics: flatClinics,
    });
  } catch (error) {
    res.status(500).json({ message: 'Error en el servidor', error: error.message });
  }
};
