const FiscalPeriod = require('../models/FiscalPeriod');
const JournalEntry = require('../models/JournalEntry');
const { getOrCreatePeriod, runInTransaction } = require('../utils/accounting');

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
    const result = await runInTransaction(async (session) => {
      const p = await FiscalPeriod.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!p) throw Object.assign(new Error('No encontrado'), { status: 404 });
      if (p.status !== 'ABIERTO') throw Object.assign(new Error('Solo se pueden cerrar períodos abiertos'), { status: 400 });
      const start = new Date(p.year, p.month - 1, 1);
      const end = new Date(p.year, p.month, 1);
      const drafts = await JournalEntry.countDocuments({ clinic: req.clinicId, status: 'BORRADOR',
        $or: [{ period: p._id }, { date: { $gte: start, $lt: end } }] }).session(session);
      if (drafts) throw Object.assign(new Error(`Hay ${drafts} asiento(s) en borrador en este período. Apruébalos o elimínalos antes de cerrar.`),
        { status: 409, code: 'DRAFTS_PENDING', drafts });
      // El cierre con activos depreciables antes del fin de mes adelantaría un
      // gasto que todavía no se ha devengado.
      if (end > new Date()) {
        const FixedAsset = require('../models/FixedAsset');
        const eligible = await FixedAsset.exists({ clinic: req.clinicId, status: 'ACTIVO',
          monthlyDepreciation: { $gt: 0 }, startDate: { $lt: end } }).session(session);
        if (eligible) throw Object.assign(new Error('Espera al fin del mes para cerrar y depreciar los activos'),
          { status: 409, code: 'DEPRECIATION_MONTH_OPEN' });
      }
      const depreciation = await require('./inventoryAdvancedController').processDepreciation({
        clinicId: req.clinicId, userId: req.user._id, year: p.year, month: p.month,
        catchUp: true, session,
      });
      p.status = 'CERRADO';
      p.closedAt = new Date();
      p.closedBy = req.user._id;
      await p.save({ session });
      return { ...p.toObject(), depreciation };
    });
    res.json(result);
  } catch (e) { res.status(e.status || 400).json({ message: e.message,
    ...(e.code ? { code: e.code } : {}), ...(e.drafts ? { drafts: e.drafts } : {}) }); }
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
    const year = Number(req.body.year);
    if (!Number.isInteger(year) || year < 1900 || year > 9999) return res.status(400).json({ message: 'Año inválido' });
    const existingClose = await JournalEntry.findOne({ clinic: req.clinicId, source: 'CIERRE', status: 'CONTABILIZADO',
      date: { $gte: new Date(year, 0, 1), $lt: new Date(year + 1, 0, 1) } });
    if (existingClose) {
      const reopened = await FiscalPeriod.countDocuments({ clinic: req.clinicId, year, status: 'ABIERTO' });
      if (reopened) return res.status(409).json({ message: 'Hay un cierre anual contabilizado y meses reabiertos; requiere revisión contable' });
      return res.json({ message: 'Cierre anual ya ejecutado', asiento: existingClose, alreadyClosed: true });
    }
    const yearStart = new Date(Number(year), 0, 1);
    const nextYearStart = new Date(Number(year) + 1, 0, 1);
    const drafts = await JournalEntry.countDocuments({
      clinic: req.clinicId, status: 'BORRADOR', date: { $gte: yearStart, $lt: nextYearStart },
    });
    if (drafts) return res.status(409).json({
      code: 'DRAFTS_PENDING',
      message: `Hay ${drafts} asiento(s) en borrador en el ejercicio ${year}. Apruébalos o elimínalos antes de cerrar.`,
      drafts,
    });
    const ChartOfAccount = require('../models/ChartOfAccount');
    const { createEntry } = require('../utils/accounting');
    const { getAccount } = require('../utils/accountMap');
    const result = await runInTransaction(async (session) => {
      const existingInTx = await JournalEntry.findOne({ clinic: req.clinicId, source: 'CIERRE', status: 'CONTABILIZADO',
        date: { $gte: yearStart, $lt: nextYearStart } }).session(session);
      if (existingInTx) return { message: 'Cierre anual ya ejecutado', asiento: existingInTx, alreadyClosed: true };
      const december = await FiscalPeriod.findOne({ clinic: req.clinicId, year, month: 12 }).session(session);
      if (december && december.status !== 'ABIERTO') throw Object.assign(new Error('Diciembre está cerrado; reábralo antes del cierre anual'), { status: 409 });

    // Asegurar que todos los meses estén creados (sin cerrar todavía: el asiento
    // de cierre debe registrarse con el período de diciembre aún ABIERTO).
    for (let m = 1; m <= 12; m++) {
      await getOrCreatePeriod(req.clinicId, new Date(year, m - 1, 15), { session });
    }

    const FixedAsset = require('../models/FixedAsset');
    const depreciable = await FixedAsset.exists({ clinic: req.clinicId, status: 'ACTIVO',
      monthlyDepreciation: { $gt: 0 }, startDate: { $lt: nextYearStart } }).session(session);
    if (depreciable) {
      // El resultado anual debe incluir la depreciación pendiente. Si alguno de
      // esos meses ya está cerrado, el servicio detiene el cierre para revisión.
      await require('./inventoryAdvancedController').processDepreciation({
        clinicId: req.clinicId, userId: req.user._id, year, month: 12,
        catchUp: true, session,
      });
    }

    // Calcular saldos de cuentas de ingreso/gasto/costo del año.
    // OJO: en aggregate el campo `clinic` (ObjectId) NO se castea desde string
    // automáticamente; req.clinicId llega como string del JWT, hay que convertirlo.
    const clinicOid = new (require('mongoose').Types.ObjectId)(req.clinicId);
    const start = new Date(year, 0, 1);
    const end = new Date(year, 11, 31, 23, 59, 59);
    const agg = await JournalEntry.aggregate([
      { $match: { clinic: clinicOid, date: { $gte: start, $lte: end }, status: 'CONTABILIZADO' } },
      { $unwind: '$lines' },
      { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
    ]).session(session);
    const accounts = await ChartOfAccount.find({ clinic: req.clinicId, type: { $in: ['INGRESO', 'GASTO', 'COSTO'] } }).session(session);
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
      const resultado = await getAccount(req.clinicId, 'resultadoEjercicio', { session });
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
        sourceModel: 'FiscalPeriod',
        sourceRef: (await FiscalPeriod.findOne({ clinic: req.clinicId, year, month: 12 }).session(session))._id,
        sourceAction: `YEAR_CLOSE:${year}`,
        lines,
        userId: req.user._id,
        session,
      });
    }

    // Ahora sí: cerrar todos los meses del año.
    await FiscalPeriod.updateMany(
      { clinic: req.clinicId, year, status: 'ABIERTO' },
      { status: 'CERRADO', closedAt: new Date(), closedBy: req.user._id }, { session }
    );

    return { message: 'Cierre anual ejecutado', utilidad, asiento: entry };
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** El mayor es continuo: los saldos de balance pasan al año siguiente sin otro asiento. */
exports.openYear = async (req, res) => {
  try {
    const { year } = req.body;
    if (!year) return res.status(400).json({ message: 'year requerido' });
    await getOrCreatePeriod(req.clinicId, new Date(year, 0, 1));
    const historicalOpening = await JournalEntry.findOne({
      clinic: req.clinicId, source: 'APERTURA',
      date: { $gte: new Date(year, 0, 1), $lt: new Date(year, 0, 2) },
      status: 'CONTABILIZADO',
    }).select('number');
    res.json({
      message: 'El mayor es continuo: los saldos ya pasan al nuevo ejercicio sin asiento de apertura.',
      policy: 'CONTINUOUS_LEDGER', asiento: null,
      historicalOpening: historicalOpening?.number || null,
    });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};
