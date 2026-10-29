/**
 * LO DEL CAJERO (29-10-2026). En la página de Ventas el cajero ve solo lo que él generó:
 * las ventas que registró o cobró y las que facturó él (aunque las registrara otro).
 * Admin, contabilidad y el super admin siguen viendo todo.
 */
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');

const esCajero = (req) => req.role === 'cajero' && !req.user?.isSuperAdmin;

/** Filtro de ventas para sumar con `$and`; null si quien pide no es cajero. */
async function filtroVentasDelCajero(req) {
  if (!esCajero(req)) return null;
  const yo = req.user._id;
  const facturadasPorMi = await Invoice.find({ createdBy: yo }).distinct('sale');
  return { $or: [{ createdBy: yo }, { cashier: yo }, { _id: { $in: facturadasPorMi } }] };
}

/** Filtro de facturas para sumar con `$and`; null si quien pide no es cajero. */
async function filtroFacturasDelCajero(req) {
  if (!esCajero(req)) return null;
  const yo = req.user._id;
  const misVentas = await Sale.find({ $or: [{ createdBy: yo }, { cashier: yo }] }).distinct('_id');
  return { $or: [{ createdBy: yo }, { sale: { $in: misVentas } }] };
}

module.exports = { esCajero, filtroVentasDelCajero, filtroFacturasDelCajero };
