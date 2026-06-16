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
    const { createEntry } = require('../utils/accounting');
    const { getAccount } = require('../utils/accountMap');

    // Asegurar que todos los meses estén creados (sin cerrar todavía: el asiento
    // de cierre debe registrarse con el período de diciembre aún ABIERTO).
    for (let m = 1; m <= 12; m++) {
      await getOrCreatePeriod(req.clinicId, new Date(year, m - 1, 15));
    }

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
      const resultado = await getAccount(req.clinicId, 'resultadoEjercicio');
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

    // Ahora sí: cerrar todos los meses del año.
    await FiscalPeriod.updateMany(
      { clinic: req.clinicId, year, status: 'ABIERTO' },
      { status: 'CERRADO', closedAt: new Date(), closedBy: req.user._id }
    );

    res.json({ message: 'Cierre anual ejecutado', utilidad, asiento: entry });
  } catch (e) {
    res.status(400).json({ message: e.message });
  }
};

/**
 * Apertura de año: genera el asiento de APERTURA del 1‑ene con los saldos de
 * cuentas de balance (Activo/Pasivo/Patrimonio) al cierre del año anterior.
 * Las cuentas de resultado no se arrastran (van a resultados acumulados).
 */
exports.openYear = async (req, res) => {
  try {
    const { year } = req.body;
    if (!year) return res.status(400).json({ message: 'year requerido' });
    const ChartOfAccount = require('../models/ChartOfAccount');
    const { createEntry } = require('../utils/accounting');
    const { getAccount } = require('../utils/accountMap');

    // Evitar duplicar la apertura
    const dup = await JournalEntry.findOne({ clinic: req.clinicId, source: 'APERTURA', date: { $gte: new Date(year, 0, 1), $lte: new Date(year, 0, 2) } });
    if (dup) return res.status(400).json({ message: `Ya existe asiento de apertura para ${year} (${dup.number})` });

    // Saldos acumulados hasta el 31‑dic del año anterior
    const cutoff = new Date(year - 1, 11, 31, 23, 59, 59);
    const agg = await JournalEntry.aggregate([
      { $match: { clinic: new (require('mongoose').Types.ObjectId)(req.clinicId), date: { $lte: cutoff }, status: 'CONTABILIZADO' } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]);
    const accounts = await ChartOfAccount.find({ clinic: req.clinicId });
    const accMap = new Map(accounts.map((a) => [String(a._id), a]));

    const lines = [];
    let totalDebit = 0, totalCredit = 0;
    for (const row of agg) {
      const acc = accMap.get(String(row._id));
      if (!acc) continue;
      if (!['ACTIVO', 'PASIVO', 'PATRIMONIO'].includes(acc.type)) continue;
      const net = +(row.debit - row.credit).toFixed(2);
      if (Math.abs(net) < 0.005) continue;
      if (net > 0) { lines.push({ account: acc._id, debit: net, credit: 0, description: `Saldo inicial ${acc.code}` }); totalDebit += net; }
      else { lines.push({ account: acc._id, debit: 0, credit: -net, description: `Saldo inicial ${acc.code}` }); totalCredit += -net; }
    }
    if (!lines.length) return res.status(400).json({ message: 'No hay saldos de balance para aperturar' });

    // Cuadrar contra resultados acumulados si hay diferencia (utilidad/pérdida no distribuida)
    const diff = +(totalDebit - totalCredit).toFixed(2);
    if (Math.abs(diff) >= 0.01) {
      const acumulados = await getAccount(req.clinicId, 'resultadosAcumulados');
      if (diff > 0) lines.push({ account: acumulados._id, debit: 0, credit: diff, description: 'Resultados acumulados (apertura)' });
      else lines.push({ account: acumulados._id, debit: -diff, credit: 0, description: 'Resultados acumulados (apertura)' });
    }

    await getOrCreatePeriod(req.clinicId, new Date(year, 0, 1));
    const entry = await createEntry({
      clinicId: req.clinicId, date: new Date(year, 0, 1),
      description: `Apertura ejercicio ${year}`, source: 'APERTURA',
      lines, userId: req.user._id,
    });
    res.json({ message: 'Apertura generada', asiento: entry });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};
