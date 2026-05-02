const bcrypt = require('bcryptjs');
const User = require('../models/User');

const VALID_ROLES = ['admin', 'cajero', 'contabilidad', 'doctor', 'call_center'];

const sanitizeClinics = (clinics, fallbackClinicId) => {
  if (!Array.isArray(clinics)) return [];
  return clinics
    .filter((c) => c && c.clinic && VALID_ROLES.includes(c.role))
    .map((c) => ({ clinic: c.clinic, role: c.role }));
};

/**
 * Lista usuarios. Por defecto solo los que pertenecen a la clínica activa.
 * El super-admin con clínica activa también ve solo los de esa clínica.
 */
exports.getUsers = async (req, res) => {
  try {
    const filter = req.clinicId ? { 'clinics.clinic': req.clinicId } : {};
    const users = await User.find(filter)
      .populate('clinics.clinic', 'name')
      .select('-password')
      .sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener usuarios', error: error.message });
  }
};

exports.getUser = async (req, res) => {
  try {
    const user = await User.findById(req.params.id)
      .populate('clinics.clinic', 'name')
      .select('-password');
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener usuario' });
  }
};

/**
 * Crear usuario (solo admin de la clínica). Asigna automáticamente la clínica activa
 * con el rol indicado. El admin puede asignar más clínicas si tiene permiso allí.
 */
exports.createUser = async (req, res) => {
  try {
    const { name, email, password, role, specialty, phone, cedula, clinics } = req.body;
    if (!name || !email || !password || !role) {
      return res.status(400).json({ message: 'Faltan campos requeridos' });
    }
    if (!VALID_ROLES.includes(role)) {
      return res.status(400).json({ message: 'Rol inválido' });
    }
    if (password.length < 6) {
      return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
    }

    const existing = await User.findOne({ email });
    if (existing) return res.status(400).json({ message: 'El email ya está registrado' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    // Construir asignaciones de clínicas. Por defecto: la clínica activa con el rol dado.
    let clinicAssignments = [{ clinic: req.clinicId, role }];
    if (Array.isArray(clinics) && clinics.length > 0 && req.user.isSuperAdmin) {
      clinicAssignments = sanitizeClinics(clinics);
    }

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      specialty,
      phone,
      cedula,
      clinics: clinicAssignments,
    });

    const populated = await User.findById(user._id)
      .populate('clinics.clinic', 'name')
      .select('-password');
    res.status(201).json(populated);
  } catch (error) {
    res.status(500).json({ message: 'Error al crear usuario', error: error.message });
  }
};

exports.updateUser = async (req, res) => {
  try {
    const { name, email, specialty, phone, cedula, active, clinics, password } = req.body;
    const update = { name, email, specialty, phone, cedula, active };
    Object.keys(update).forEach((k) => update[k] === undefined && delete update[k]);

    if (password) {
      if (password.length < 6) {
        return res.status(400).json({ message: 'La contraseña debe tener al menos 6 caracteres' });
      }
      const salt = await bcrypt.genSalt(10);
      update.password = await bcrypt.hash(password, salt);
    }

    if (Array.isArray(clinics)) {
      // Solo super-admin o admin pueden modificar asignaciones; el admin solo de su clínica
      if (req.user.isSuperAdmin) {
        update.clinics = sanitizeClinics(clinics);
      } else {
        // Admin de clínica: solo puede agregar/cambiar el rol del usuario para SU clínica
        const target = await User.findById(req.params.id);
        if (!target) return res.status(404).json({ message: 'Usuario no encontrado' });
        const others = target.clinics.filter((c) => String(c.clinic) !== String(req.clinicId));
        const newForThis = clinics.find((c) => String(c.clinic) === String(req.clinicId));
        const merged = [...others];
        if (newForThis && VALID_ROLES.includes(newForThis.role)) {
          merged.push({ clinic: req.clinicId, role: newForThis.role });
        }
        update.clinics = merged;
      }
    }

    const user = await User.findByIdAndUpdate(req.params.id, update, {
      new: true,
      runValidators: true,
    })
      .populate('clinics.clinic', 'name')
      .select('-password');
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error al actualizar usuario', error: error.message });
  }
};

exports.deleteUser = async (req, res) => {
  try {
    const user = await User.findByIdAndUpdate(
      req.params.id,
      { active: false },
      { new: true }
    ).select('-password');
    if (!user) return res.status(404).json({ message: 'Usuario no encontrado' });
    res.json({ message: 'Usuario desactivado' });
  } catch (error) {
    res.status(500).json({ message: 'Error al eliminar usuario' });
  }
};

/**
 * Lista doctores de la clínica activa.
 */
exports.getDoctors = async (req, res) => {
  try {
    const doctors = await User.find({
      active: true,
      clinics: { $elemMatch: { clinic: req.clinicId, role: 'doctor' } },
    })
      .select('-password')
      .sort({ name: 1 });
    res.json(doctors);
  } catch (error) {
    res.status(500).json({ message: 'Error al obtener doctores', error: error.message });
  }
};
