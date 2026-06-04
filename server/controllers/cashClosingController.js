const mongoose = require('mongoose');
const CashClosing = require('../models/CashClosing');
const Sale = require('../models/Sale');
const { createEntry } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');

const oid = (v) => new mongoose.Types.ObjectId(v);

const dayRange = (dateStr) => {
  const base = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
  return { start, end };
};

/** Agrega las ventas (por método de pago) en un rango de fechas. */
const salesByMethod = async (clinicId, start, end) => {
  const rows = await Sale.aggregate([
    { $match: { clinic: oid(clinicId), status: 'completada', createdAt: { $gte: start, $lte: end } } },
    { $group: { _id: '$paymentMethod', total: { $sum: '$total' }, count: { $sum: 1 } } },
  ]);
  const byMethod = { efectivo: 0, tarjeta: 0, transferencia: 0 };
  let salesCount = 0, totalSales = 0;
  rows.forEach((r) => { if (r._id in byMethod) byMethod[r._id] = r.total; salesCount += r.count; totalSales += r.total; });
  return { byMethod, salesCount, totalSales };
};

/** Caja abierta actualmente (si existe), con su resumen en vivo. */
exports.current = async (req, res) => {
  try {
    const open = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA' })
      .populate('openedBy', 'name')
      .sort({ openedAt: -1 });
    if (!open) return res.json({ open: null });
    const { byMethod, salesCount, totalSales } = await salesByMethod(req.clinicId, open.openedAt, new Date());
    const expectedCash = +((open.openingBalance || 0) + byMethod.efectivo).toFixed(2);
    res.json({ open, live: { byMethod, salesCount, totalSales, expectedCash } });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Abre la caja con un fondo inicial. Solo puede haber una caja abierta a la vez. */
exports.open = async (req, res) => {
  try {
    const existing = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA' });
    if (existing) return res.status(400).json({ message: 'Ya hay una caja abierta. Ciérrala antes de abrir otra.' });
    const openingBalance = Number(req.body.openingBalance) || 0;
    const now = new Date();
    const closing = await CashClosing.create({
      clinic: req.clinicId,
      date: now,
      openedAt: now,
      openedBy: req.user._id,
      openingBalance,
      status: 'ABIERTA',
      notes: req.body.notes || '',
    });
    res.status(201).json(closing);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/** Resumen del día (compatibilidad): ventas por método de pago. */
exports.summary = async (req, res) => {
  try {
    const { start, end } = dayRange(req.query.date);
    const { byMethod, salesCount, totalSales } = await salesByMethod(req.clinicId, start, end);
    const last = await CashClosing.findOne({ clinic: req.clinicId, status: 'CERRADO' }).sort({ date: -1 });
    res.json({ byMethod, salesCount, totalSales, suggestedOpening: last ? last.countedCash : 0, lastClosing: last });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.status) filter.status = req.query.status;
  if (req.query.startDate || req.query.endDate) {
    filter.date = {};
    if (req.query.startDate) filter.date.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.date.$lte = new Date(req.query.endDate + 'T23:59:59.999');
  }
  const items = await CashClosing.find(filter)
    .populate('closedBy', 'name')
    .populate('openedBy', 'name')
    .sort({ date: -1 })
    .limit(200);
  res.json(items);
};

/** Genera (best-effort) el asiento de ajuste por diferencia al cerrar caja. */
const postDifferenceEntry = async (clinicId, closing, userId) => {
  const diff = closing.difference;
  if (!diff || Math.abs(diff) < 0.01) return null;
  try {
    const caja = await getAccount(clinicId, 'caja');
    let lines;
    if (diff < 0) {
      // Faltante: pérdida (gasto) contra caja
      const faltante = await getAccount(clinicId, 'faltanteCaja');
      const amount = +Math.abs(diff).toFixed(2);
      lines = [
        { account: faltante._id, debit: amount, credit: 0, description: 'Faltante de caja' },
        { account: caja._id, debit: 0, credit: amount, description: 'Faltante de caja' },
      ];
    } else {
      // Sobrante: ingreso contra caja
      const sobrante = await getAccount(clinicId, 'sobranteCaja');
      const amount = +diff.toFixed(2);
      lines = [
        { account: caja._id, debit: amount, credit: 0, description: 'Sobrante de caja' },
        { account: sobrante._id, debit: 0, credit: amount, description: 'Sobrante de caja' },
      ];
    }
    const entry = await createEntry({
      clinicId, date: closing.closedAt || new Date(),
      description: `Ajuste cierre de caja ${closing.date.toISOString().slice(0, 10)}`,
      source: 'CIERRE', sourceRef: closing._id, sourceModel: 'CashClosing',
      lines, userId,
    });
    return entry;
  } catch (e) {
    console.warn('No se pudo generar asiento de diferencia de caja:', e.message);
    return null;
  }
};

/** Cierra la caja abierta indicada: cuenta efectivo y registra la diferencia. */
exports.close = async (req, res) => {
  try {
    const closing = await CashClosing.findOne({ _id: req.params.id, clinic: req.clinicId, status: 'ABIERTA' });
    if (!closing) return res.status(404).json({ message: 'Caja abierta no encontrada' });

    const closedAt = new Date();
    const { byMethod, salesCount, totalSales } = await salesByMethod(req.clinicId, closing.openedAt, closedAt);
    const countedCash = Number(req.body.countedCash) || 0;
    const expectedCash = +((closing.openingBalance || 0) + byMethod.efectivo).toFixed(2);
    const difference = +(countedCash - expectedCash).toFixed(2);

    closing.closedAt = closedAt;
    closing.closedBy = req.user._id;
    closing.expectedCash = expectedCash;
    closing.countedCash = countedCash;
    closing.difference = difference;
    closing.byMethod = byMethod;
    closing.salesCount = salesCount;
    closing.totalSales = totalSales;
    closing.denominations = req.body.denominations || [];
    if (req.body.notes) closing.notes = req.body.notes;
    closing.status = 'CERRADO';

    const entry = await postDifferenceEntry(req.clinicId, closing, req.user._id);
    if (entry) closing.journalEntry = entry._id;
    await closing.save();
    res.json(closing);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/** Cierre directo (legacy de un solo paso, por día). Mantiene compatibilidad. */
exports.create = async (req, res) => {
  try {
    const { date, openingBalance = 0, countedCash = 0, denominations = [], notes = '' } = req.body;
    const { start, end } = dayRange(date);
    const { byMethod, salesCount, totalSales } = await salesByMethod(req.clinicId, start, end);
    const expectedCash = +((Number(openingBalance) || 0) + byMethod.efectivo).toFixed(2);
    const difference = +((Number(countedCash) || 0) - expectedCash).toFixed(2);

    const closing = await CashClosing.create({
      clinic: req.clinicId, date: start, closedAt: new Date(),
      openingBalance: Number(openingBalance) || 0,
      expectedCash, countedCash: Number(countedCash) || 0, difference,
      byMethod, salesCount, totalSales, denominations, notes,
      status: 'CERRADO',
      closedBy: req.user._id,
    });
    const entry = await postDifferenceEntry(req.clinicId, closing, req.user._id);
    if (entry) { closing.journalEntry = entry._id; await closing.save(); }
    res.status(201).json(closing);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.cancel = async (req, res) => {
  try {
    const c = await CashClosing.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!c) return res.status(404).json({ message: 'No encontrado' });
    c.status = 'ANULADO';
    await c.save();
    res.json(c);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
