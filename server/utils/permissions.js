/**
 * PERMISOS FINOS derivados de los ROLES que ya existen. No es un sistema paralelo: `requireRole`
 * sigue siendo el guardián de las rutas; esto solo nombra las CAPACIDADES que cada rol tiene
 * dentro de una ruta a la que ya entró, para poder responder distinto a gente distinta.
 *
 * La capacidad importante es `inventory.costs`. Ocultar una columna en React no es un permiso:
 * cualquiera abre la pestaña de red y lee el costo. Por eso el BACKEND omite los importes
 * (kardex, tomas y sus Excel) cuando el rol no puede verlos: lo que no se envía, no se filtra.
 *
 * Compatibilidad: `admin` y `contabilidad` conservan todo lo que tenían.
 */

/** Capacidades por rol. Un rol que no está aquí no tiene ninguna. */
const CAPS = {
  admin: ['*'],
  contabilidad: [
    'inventory.view', 'inventory.costs', 'inventory.export',
    'count.start', 'count.edit', 'count.confirm',
    'warehouse.view', 'warehouse.manage',
    'sales.report', 'sales.export', 'sales.presets',
    'journal.view',
    // Flujo de caja: ve la proyección/Excel Y configura (clasifica, reglas, saldo, partidas).
    'cashflow.view', 'cashflow.manage',
  ],
  // La caja ve el inventario para trabajar (cantidades) y puede iniciar/contar una toma,
  // pero NO ve costos, no confirma el ajuste contable, no exporta y no abre asientos.
  // En el FLUJO DE CAJA solo VISUALIZA (proyección + Excel + detalle): la clasificación,
  // el saldo manual, las partidas y las reglas las hace contabilidad/admin (cashflow.manage).
  cajero: ['inventory.view', 'count.start', 'count.edit', 'warehouse.view', 'sales.report', 'cashflow.view'],
  // Enfermería y bodega consultan existencias; nada de dinero.
  enfermeria: ['inventory.view', 'count.start', 'count.edit', 'warehouse.view'],
  // Marketing solo mira ventas (sin costos ni márgenes) y no exporta.
  marketing: ['sales.report'],
};

/** Roles que funcionalmente son doctores (misma expansión que `requireRole`). */
const { DOCTOR_LIKE_ROLES: DOCTOR_LIKE } = require('../constants/roles');

/** ¿El rol tiene la capacidad? El super-admin siempre. */
function can(role, cap, { isSuperAdmin = false } = {}) {
  if (isSuperAdmin) return true;
  const key = DOCTOR_LIKE.includes(role) ? 'doctor' : role;
  const caps = CAPS[key] || [];
  return caps.includes('*') || caps.includes(cap);
}

/** Helper de request: `canReq(req, 'inventory.costs')`. */
function canReq(req, cap) {
  return can(req?.role, cap, { isSuperAdmin: !!req?.user?.isSuperAdmin });
}

/**
 * Middleware: exige una capacidad. Se usa DESPUÉS de `requireRole` para afinar dentro de la
 * ruta (p.ej. cualquiera con acceso al inventario entra al kardex, pero solo quien puede
 * exportar llega al .xlsx).
 */
const requireCap = (cap) => (req, res, next) => {
  if (canReq(req, cap)) return next();
  return res.status(403).json({ message: 'No tienes permisos para esta acción' });
};

module.exports = { CAPS, can, canReq, requireCap };
