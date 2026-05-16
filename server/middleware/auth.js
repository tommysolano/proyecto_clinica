const jwt = require('jsonwebtoken');
const User = require('../models/User');

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
 * Regla especial: cualquier ruta que permita 'call_center' también acepta
 * 'supervisor_call_center' (el supervisor es un superset del agente).
 */
const requireRole = (...roles) => (req, res, next) => {
  if (req.user?.isSuperAdmin) return next();
  const expanded = roles.includes('call_center')
    ? Array.from(new Set([...roles, 'supervisor_call_center']))
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
