const mongoose = require('mongoose');
const CashClosing = require('../models/CashClosing');
const Sale = require('../models/Sale');

const oid = (v) => new mongoose.Types.ObjectId(v);

const dayRange = (dateStr) => {
  const base = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
  return { start, end };
};

/** Resumen del día: ventas por método de pago para preparar el cierre. */
exports.summary = async (req, res) => {
  try {
    const { start, end } = dayRange(req.query.date);
    const rows = await Sale.aggregate([
      { $match: { clinic: oid(req.clinicId), status: 'completada', createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$paymentMethod', total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]);
    const byMethod = { efectivo: 0, tarjeta: 0, transferencia: 0 };
    let salesCount = 0, totalSales = 0;
    rows.forEach((r) => { if (r._id in byMethod) byMethod[r._id] = r.total; salesCount += r.count; totalSales += r.total; });
    // Último cierre para sugerir fondo de caja
    const last = await CashClosing.findOne({ clinic: req.clinicId, status: 'CERRADO' }).sort({ date: -1 });
    res.json({ byMethod, salesCount, totalSales, suggestedOpening: last ? last.countedCash : 0, lastClosing: last });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.startDate || req.query.endDate) {
    filter.date = {};
    if (req.query.startDate) filter.date.$gte = new Date(req.query.startDate);
    if (req.query.endDate) filter.date.$lte = new Date(req.query.endDate + 'T23:59:59.999');
  }
  const items = await CashClosing.find(filter).populate('closedBy', 'name').sort({ date: -1 }).limit(200);
  res.json(items);
};

exports.create = async (req, res) => {
  try {
    const { date, openingBalance = 0, countedCash = 0, denominations = [], notes = '' } = req.body;
    const { start, end } = dayRange(date);
    const rows = await Sale.aggregate([
      { $match: { clinic: oid(req.clinicId), status: 'completada', createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: '$paymentMethod', total: { $sum: '$total' }, count: { $sum: 1 } } },
    ]);
    const byMethod = { efectivo: 0, tarjeta: 0, transferencia: 0 };
    let salesCount = 0, totalSales = 0;
    rows.forEach((r) => { if (r._id in byMethod) byMethod[r._id] = r.total; salesCount += r.count; totalSales += r.total; });

    const expectedCash = +((Number(openingBalance) || 0) + byMethod.efectivo).toFixed(2);
    const difference = +((Number(countedCash) || 0) - expectedCash).toFixed(2);

    const closing = await CashClosing.create({
      clinic: req.clinicId, date: start,
      openingBalance: Number(openingBalance) || 0,
      expectedCash, countedCash: Number(countedCash) || 0, difference,
      byMethod, salesCount, totalSales, denominations, notes,
      closedBy: req.user._id,
    });
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
