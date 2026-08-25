/**
 * PERMISOS FINOS derivados de los ROLES que ya existen. No es un sistema paralelo: `requireRole`
 * sigue siendo el guardián de las rutas; esto solo nombra las CAPACIDADES que cada rol tiene
 * dentro de una ruta a la que ya entró, para poder responder distinto a gente distinta.
 *
 * La capacidad importante es `inventory.costs`. Ocultar una columna en React no es un permiso:
 * cualquiera abre la pestaña de red y lee el costo. Por eso el BACKEND omite los importes
 * (kardex, tomas y sus Excel) cuando el rol no puede verlos: lo que no se envía, no se filtra.
 *
 * Mismo criterio para `patients.contactData` (cédula, dirección, teléfono, WhatsApp y correo
 * del paciente): es SOLO del administrador —le basta con `'*'`, no hace falta listarla—, así
 * que el servidor la borra de la respuesta para todos los demás roles. `patients.billingData`
 * es su única excepción, explicada abajo.
 *
 * `patients.observations.moderate` es la otra capacidad exclusiva del admin: una observación
 * del paciente la edita quien la escribió, y el admin además de eso (queda registrado como
 * "modificado por"). Tampoco se lista: `'*'` ya se la da solo a él.
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
    // Ver 'patients.billingData' abajo: cobra cartera y necesita identificar al cliente.
    'patients.billingData',
  ],
  // La caja ve el inventario para trabajar (cantidades) y puede iniciar/contar una toma,
  // pero NO ve costos, no confirma el ajuste contable, no exporta y no abre asientos.
  // En el FLUJO DE CAJA solo VISUALIZA (proyección + Excel + detalle): la clasificación,
  // el saldo manual, las partidas y las reglas las hace contabilidad/admin (cashflow.manage).
  //
  // `patients.billingData` NO es "ver los datos del paciente": la ficha del paciente y el
  // listado de Clientes le llegan igual de censurados que a todos (eso es
  // `patients.contactData`, que solo tiene el admin). Es el permiso para que los SELECTORES
  // de cliente de Nueva venta, Cotizaciones y Pagos —los únicos que lo piden, con
  // `?withContact=1`— traigan cédula, correo y teléfono: sin ellos el comprobante
  // electrónico saldría a consumidor final y la cartera quedaría sin identificación.
  cajero: [
    'inventory.view', 'count.start', 'count.edit', 'warehouse.view', 'sales.report', 'cashflow.view',
    'patients.billingData',
  ],
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
