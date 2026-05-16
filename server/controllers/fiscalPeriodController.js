const FiscalPeriod = require('../models/FiscalPeriod');
const JournalEntry = require('../models/JournalEntry');
const { getOrCreatePeriod } = require('../utils/accounting');

exports.list = async (req, res) => {
  const { year } = req.query;
  const filter = { clinic: req.clinicId };
  if (year) filter.year = Number(year);
  const periods = await FiscalPeriod.find(filter).sort({ year: -1, month: -1 });
  res.json(periods);
};

exports.create = async (req, res) => {
  try {
    const { year, month } = req.body;
    if (!year || !month) return res.status(400).json({ message: 'year y month requeridos' });
    const exists = await FiscalPeriod.findOne({ clinic: req.clinicId, year, month });
    if (exists) return res.status(400).json({ message: 'Período ya existe' });
    const p = await FiscalPeriod.create({ clinic: req.clinicId, year, month });
    res.status(201).json(p);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.close = async (req, res) => {
  try {
    const p = await FiscalPeriod.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!p) return res.status(404).json({ message: 'No encontrado' });
    if (p.status !== 'ABIERTO') return res.status(400).json({ message: 'Solo se pueden cerrar períodos abiertos' });
    p.status = 'CERRADO';
    p.closedAt = new Date();
    p.closedBy = req.user._id;
    await p.save();
    res.json(p);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.reopen = async (req, res) => {
  try {
    const p = await FiscalPeriod.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!p) return res.status(404).json({ message: 'No encontrado' });
    if (p.status === 'BLOQUEADO') return res.status(400).json({ message: 'Período bloqueado, no se puede reabrir' });
    p.status = 'ABIERTO';
    p.closedAt = null;
    p.closedBy = null;
    await p.save();
    res.json(p);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.lock = async (req, res) => {
  const p = await FiscalPeriod.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!p) return res.status(404).json({ message: 'No encontrado' });
  p.status = 'BLOQUEADO';
  await p.save();
  res.json(p);
};

/**
 * Cierre anual: marca todos los meses del año como CERRADOS y genera asiento de cierre
 * trasladando saldos de ingresos/gastos a Resultado del ejercicio.
 */
exports.closeYear = async (req, res) => {
  try {
    const { year } = req.body;
    if (!year) return res.status(400).json({ message: 'year requerido' });
    const ChartOfAccount = require('../models/ChartOfAccount');
    const { createEntry, findAccount } = require('../utils/accounting');

    // Asegurar que todos los meses estén creados y cerrarlos
    for (let m = 1; m <= 12; m++) {
      await getOrCreatePeriod(req.clinicId, new Date(year, m - 1, 15));
    }
    await FiscalPeriod.updateMany(
      { clinic: req.clinicId, year, status: 'ABIERTO' },
      { status: 'CERRADO', closedAt: new Date(), closedBy: req.user._id }
    );

    // Calcular saldos de cuentas de ingreso/gasto/costo del año
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31, 23, 59, 59);
    const agg = await JournalEntry.aggregate([
      { $match: { clinic: req.clinicId, date: { $gte: start, $lte: end }, status: 'CONTABILIZADO' } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]);
    const accounts = await ChartOfAccount.find({ clinic: req.clinicId, type: { $in: ['INGRESO', 'GASTO', 'COSTO'] } });
    const accMap = new Map(accounts.map((a) => [String(a._id), a]));
    const lines = [];
    let netIngreso = 0;
    let netGastoCosto = 0;
    for (const row of agg) {
      const acc = accMap.get(String(row._id));
      if (!acc) continue;
      const saldo = row.debit - row.credit; // débito - crédito
      if (acc.type === 'INGRESO') {
        // Ingreso es crédito; saldo crédito = credit - debit > 0
        const ingreso = row.credit - row.debit;
        if (Math.abs(ingreso) > 0.001) {
          lines.push({ accountCode: acc.code, debit: ingreso, credit: 0, description: `Cierre ingresos ${acc.code}` });
          netIngreso += ingreso;
        }
      } else {
        // Gastos/Costos son débito
        if (Math.abs(saldo) > 0.001) {
          lines.push({ accountCode: acc.code, debit: 0, credit: saldo, description: `Cierre gastos/costos ${acc.code}` });
          netGastoCosto += saldo;
        }
      }
    }
    const utilidad = netIngreso - netGastoCosto;
    if (Math.abs(utilidad) > 0.001) {
      const resultado = await findAccount(req.clinicId, { code: '3.3.02' });
      if (utilidad >= 0) {
        lines.push({ account: resultado._id, debit: 0, credit: utilidad, description: 'Utilidad del ejercicio' });
      } else {
        lines.push({ account: resultado._id, debit: -utilidad, credit: 0, description: 'Pérdida del ejercicio' });
      }
    }
    let entry = null;
    if (lines.length >= 2) {
      entry = await createEntry({
        clinicId: req.clinicId,
        date: end,
        description: `Cierre anual ${year}`,
        source: 'CIERRE',
        lines,
        userId: req.user._id,
      });
    }
    res.json({ message: 'Cierre anual ejecutado', utilidad, asiento: entry });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};
