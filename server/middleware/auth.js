const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { isAccessBlocked, blockMessage } = require('../utils/accessControl');
const { DOCTOR_ROLE, DOCTOR_SPECIALTY_ROLES } = require('../constants/roles');

/**
 * Verifica el JWT y carga el usuario.
 * Si el token incluye `clinicId`, lo expone en `req.clinicId` y resuelve `req.role`.
 */
const auth = async (req, res, next) => {
  try {
    const token = req.header('Authorization')?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ message: 'No autorizado, token requerido' });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');
    if (!user || !user.active) {
      return res.status(401).json({ message: 'No autorizado' });
    }

    req.user = user;
    req.tokenPayload = decoded;

    // Bloqueo de acceso al sistema (gestionado por el super-admin). Aplica a
    // cualquier petición autenticada; el super-admin y los usuarios exceptuados
    // nunca se bloquean.
    const block = await isAccessBlocked(user);
    if (block.blocked) {
      return res.status(403).json({ message: blockMessage(block.rule), code: 'ACCESS_BLOCKED' });
    }

    if (decoded.clinicId) {
      req.clinicId = decoded.clinicId;
      const role = user.getRoleForClinic(decoded.clinicId);
      if (!role && !user.isSuperAdmin) {
        return res.status(403).json({ message: 'No tienes acceso a esta clínica' });
      }
      req.role = user.isSuperAdmin && !role ? 'admin' : role;
    }

    next();
  } catch (error) {
    res.status(401).json({ message: 'Token inválido' });
  }
};

/**
 * Garantiza que el token incluya clinicId (para rutas tenant-scoped).
 */
const requireClinic = (req, res, next) => {
  if (!req.clinicId) {
    return res
      .status(403)
      .json({ message: 'Debe seleccionar una clínica', code: 'CLINIC_REQUIRED' });
  }
  next();
};

/**
 * Restringe el acceso a roles específicos dentro de la clínica activa.
 */
const requireRole = (...roles) => (req, res, next) => {
  if (req.user?.isSuperAdmin) return next();
  // Las especialidades ('optica', 'ginecologia', 'podologia', 'odontologia',
  // 'cosmetologia') son funcionalmente doctores: cualquier ruta que permita
  // 'doctor' también las acepta. La lista vive en constants/roles.js.
  const expanded = roles.includes(DOCTOR_ROLE)
    ? Array.from(new Set([...roles, ...DOCTOR_SPECIALTY_ROLES]))
    : roles;
  if (!req.role || !expanded.includes(req.role)) {
    return res.status(403).json({ message: 'No tienes permisos para esta acción' });
  }
  next();
};

const requireSuperAdmin = (req, res, next) => {
  if (!req.user?.isSuperAdmin) {
    return res.status(403).json({ message: 'Solo el super administrador puede realizar esta acción' });
  }
  next();
};

module.exports = { auth, requireClinic, requireRole, requireSuperAdmin };
