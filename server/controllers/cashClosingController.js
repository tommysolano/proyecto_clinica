const mongoose = require('mongoose');
const CashClosing = require('../models/CashClosing');
const CashMovement = require('../models/CashMovement');
const JournalEntry = require('../models/JournalEntry');
const Sale = require('../models/Sale');
const { createEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');

const oid = (v) => new mongoose.Types.ObjectId(v);

/** Neto de movimientos de caja (ingresos - egresos) de una sesión abierta. */
const cashMovementsNet = async (clinicId, cashSessionId) => {
  const rows = await CashMovement.aggregate([
    { $match: { clinic: oid(clinicId), cashSession: oid(cashSessionId), voided: false } },
    { $group: { _id: '$type', total: { $sum: '$amount' } } },
  ]);
  let net = 0;
  for (const r of rows) net += (r._id === 'INGRESO' ? 1 : -1) * r.total;
  return +net.toFixed(2);
};

/**
 * Movimiento neto (debe - haber) de la cuenta Caja en el mayor durante la sesión.
 * Es la fuente de verdad del efectivo que entró/salió físicamente del cajón:
 * captura ventas de contado, cobros de crédito en efectivo, anticipos, gastos de
 * caja chica, retiros y depósitos, todo de forma uniforme y sin doble conteo.
 */
const cajaLedgerNet = async (clinicId, start, end, session = null) => {
  const caja = await getAccount(clinicId, 'caja', session ? { session } : {});
  const pipeline = [
    { $match: { clinic: oid(clinicId), status: 'CONTABILIZADO', date: { $gte: start, $lte: end } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': caja._id } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ];
  const agg = session
    ? await JournalEntry.aggregate(pipeline).session(session)
    : await JournalEntry.aggregate(pipeline);
  return +(((agg[0]?.debit || 0) - (agg[0]?.credit || 0)).toFixed(2));
};

const dayRange = (dateStr) => {
  const base = dateStr ? new Date(dateStr) : new Date();
  const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, 0, 0);
  const end = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 23, 59, 59, 999);
  return { start, end };
};

/**
 * Agrega las ventas (por método de pago) en un rango de fechas. Si se pasa
 * `cashierId`, solo cuenta las ventas registradas por ese cajero (caja por cajero).
 */
const salesByMethod = async (clinicId, start, end, cashierId = null) => {
  const match = { clinic: oid(clinicId), status: 'completada', createdAt: { $gte: start, $lte: end } };
  if (cashierId) match.cashier = oid(cashierId);
  const rows = await Sale.aggregate([
    { $match: match },
    { $group: { _id: '$paymentMethod', total: { $sum: '$total' }, count: { $sum: 1 } } },
  ]);
  const byMethod = { efectivo: 0, tarjeta: 0, transferencia: 0 };
  let salesCount = 0, totalSales = 0;
  rows.forEach((r) => { if (r._id in byMethod) byMethod[r._id] = r.total; salesCount += r.count; totalSales += r.total; });
  return { byMethod, salesCount, totalSales };
};

/** Caja abierta del cajero actual (si existe), con su resumen en vivo. */
exports.current = async (req, res) => {
  try {
    const open = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', openedBy: req.user._id })
      .populate('openedBy', 'name')
      .sort({ openedAt: -1 });
    if (!open) return res.json({ open: null });
    const now = new Date();
    const { byMethod, salesCount, totalSales } = await salesByMethod(req.clinicId, open.openedAt, now);
    const movementsNet = await cashMovementsNet(req.clinicId, open._id);
    // Efectivo esperado = fondo inicial + neto de la cuenta Caja en el mayor
    // (incluye ventas de contado, cobros de crédito en efectivo, gastos de caja
    //  chica, retiros y depósitos), sin doble conteo.
    const cashNet = await cajaLedgerNet(req.clinicId, open.openedAt, now);
    const expectedCash = +((open.openingBalance || 0) + cashNet).toFixed(2);
    res.json({ open, live: { byMethod, salesCount, totalSales, movementsNet, cashNet, expectedCash } });
  } catch (e) { res.status(500).json({ message: e.message }); }
};

/** Abre la caja del cajero actual con un fondo inicial. Una caja abierta por cajero. */
exports.open = async (req, res) => {
  try {
    const existing = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', openedBy: req.user._id });
    if (existing) return res.status(400).json({ message: 'Ya tienes una caja abierta. Ciérrala antes de abrir otra.' });
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

/**
 * Genera el asiento de ajuste por diferencia al cerrar caja.
 * Devuelve { entry, error }: si hay diferencia pero no se pudo generar el
 * asiento (p. ej. falta una cuenta o el período está cerrado), `error` trae el
 * motivo para avisar al usuario en vez de fallar en silencio. El cierre físico
 * de caja NO se bloquea por esto.
 */
const postDifferenceEntry = async (clinicId, closing, userId, session) => {
  const diff = closing.difference;
  if (!diff || Math.abs(diff) < 0.01) return { entry: null, error: null };
  await assertPeriodOpen(clinicId, closing.closedAt || new Date(), { session });
  const caja = await getAccount(clinicId, 'caja', { session });
    let lines;
    if (diff < 0) {
      // Faltante: pérdida (gasto) contra caja
      const faltante = await getAccount(clinicId, 'faltanteCaja', { session });
      const amount = +Math.abs(diff).toFixed(2);
      lines = [
        { account: faltante._id, debit: amount, credit: 0, description: 'Faltante de caja' },
        { account: caja._id, debit: 0, credit: amount, description: 'Faltante de caja' },
      ];
    } else {
      // Sobrante: ingreso contra caja
      const sobrante = await getAccount(clinicId, 'sobranteCaja', { session });
      const amount = +diff.toFixed(2);
      lines = [
        { account: caja._id, debit: amount, credit: 0, description: 'Sobrante de caja' },
        { account: sobrante._id, debit: 0, credit: amount, description: 'Sobrante de caja' },
      ];
    }
    const entry = await createEntry({
      clinicId, date: closing.closedAt || new Date(),
      description: `Ajuste cierre de caja ${closing.date.toISOString().slice(0, 10)}`,
      source: 'CIERRE', sourceRef: closing._id, sourceModel: 'CashClosing', sourceAction: 'DIFFERENCE',
      lines, userId, session,
    });
  return { entry, error: null };
};

/** Cierra la caja abierta indicada: cuenta efectivo y registra la diferencia. */
exports.close = async (req, res) => {
  try {
    {
      const closingId = await runInTransaction(async (session) => {
        const closing = await CashClosing.findOne({ _id: req.params.id, clinic: req.clinicId, status: 'ABIERTA' }).session(session);
        if (!closing) throw Object.assign(new Error('Caja abierta no encontrada'), { status: 404 });

        const closedAt = new Date();
        const { byMethod, salesCount, totalSales } = await salesByMethod(req.clinicId, closing.openedAt, closedAt);
        const movementsNet = await cashMovementsNet(req.clinicId, closing._id);
        const countedCash = Number(req.body.countedCash) || 0;
        // Efectivo esperado = fondo inicial + neto de la cuenta Caja en el mayor
        // (ventas de contado, cobros de crédito en efectivo, gastos de caja chica,
        //  retiros y depósitos), sin doble conteo.
        const cashNet = await cajaLedgerNet(req.clinicId, closing.openedAt, closedAt, session);
        const expectedCash = +((closing.openingBalance || 0) + cashNet).toFixed(2);
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

        const { entry } = await postDifferenceEntry(req.clinicId, closing, req.user._id, session);
        if (entry) closing.journalEntry = entry._id;
        await closing.save({ session });
        return closing._id;
      });
      const closing = await CashClosing.findById(closingId);
      return res.json({ ...closing.toObject(), accountingWarning: null });
    }
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/** Cierre directo (legacy de un solo paso, por día). Mantiene compatibilidad. */
exports.create = async (req, res) => {
  try {
    {
      const closingId = await runInTransaction(async (session) => {
        const { date, openingBalance = 0, countedCash = 0, denominations = [], notes = '' } = req.body;
        const { start, end } = dayRange(date);
        const { byMethod, salesCount, totalSales } = await salesByMethod(req.clinicId, start, end);
        const expectedCash = +((Number(openingBalance) || 0) + byMethod.efectivo).toFixed(2);
        const difference = +((Number(countedCash) || 0) - expectedCash).toFixed(2);
        const [closing] = await CashClosing.create([{
          clinic: req.clinicId,
          date: start,
          closedAt: new Date(),
          openingBalance: Number(openingBalance) || 0,
          expectedCash,
          countedCash: Number(countedCash) || 0,
          difference,
          byMethod,
          salesCount,
          totalSales,
          denominations,
          notes,
          status: 'CERRADO',
          closedBy: req.user._id,
        }], { session });
        const { entry } = await postDifferenceEntry(req.clinicId, closing, req.user._id, session);
        if (entry) {
          closing.journalEntry = entry._id;
          await closing.save({ session });
        }
        return closing._id;
      });
      const closing = await CashClosing.findById(closingId);
      return res.status(201).json({ ...closing.toObject(), accountingWarning: null });
    }
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

/**
 * Registra un movimiento de caja (ingreso vario, gasto/egreso de caja chica,
 * retiro o depósito a banco) en la sesión abierta, con su asiento contra Caja.
 */
exports.addMovement = async (req, res) => {
  try {
    const ChartOfAccount = require('../models/ChartOfAccount');
    const BankAccount = require('../models/BankAccount');
    const BankTransaction = require('../models/BankTransaction');
    const movementId = await runInTransaction(async (session) => {
      const open = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', openedBy: req.user._id }).session(session);
      if (!open) throw Object.assign(new Error('No tienes una caja abierta'), { status: 400 });

      const { type, description } = req.body;
      if (!['INGRESO', 'EGRESO', 'GASTO', 'RETIRO', 'DEPOSITO'].includes(type)) {
        throw Object.assign(new Error('Tipo de movimiento inválido'), { status: 400 });
      }
      const amount = +(Number(req.body.amount) || 0).toFixed(2);
      if (amount <= 0) throw Object.assign(new Error('Monto inválido'), { status: 400 });
      const date = req.body.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, date, { session });

      const caja = await getAccount(req.clinicId, 'caja', { session });
      const lines = [];
      let counterpartAccount = null;
      let bank = null;
      let bankTx = null;

      // Resolver cuenta contraparte (si la envían por id) o por defecto según el tipo.
      async function resolveCounterpart(defaultRole) {
        if (req.body.counterpartAccount) {
          const acc = await ChartOfAccount.findOne({ _id: req.body.counterpartAccount, clinic: req.clinicId }).session(session);
          if (acc) return acc;
        }
        return getAccount(req.clinicId, defaultRole, { session });
      }

      if (type === 'INGRESO') {
        counterpartAccount = await resolveCounterpart('otrosIngresos');
        lines.push({ account: caja._id, debit: amount, credit: 0, description: description || 'Ingreso a caja' });
        lines.push({ account: counterpartAccount._id, debit: 0, credit: amount, description: description || 'Ingreso a caja' });
      } else if (type === 'DEPOSITO') {
        if (!req.body.bankAccount) throw Object.assign(new Error('bankAccount requerido para depósito'), { status: 400 });
        bank = await BankAccount.findOne({ _id: req.body.bankAccount, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
        lines.push({ account: bank.chartAccount, debit: amount, credit: 0, description: description || 'Depósito a banco' });
        lines.push({ account: caja._id, debit: 0, credit: amount, description: description || 'Depósito a banco' });
      } else {
        // EGRESO / GASTO / RETIRO
        counterpartAccount = await resolveCounterpart('otrosGastos');
        lines.push({ account: counterpartAccount._id, debit: amount, credit: 0, description: description || type });
        lines.push({ account: caja._id, debit: 0, credit: amount, description: description || type });
      }

      const entry = await createEntry({
        clinicId: req.clinicId, date,
        description: description || `Movimiento de caja ${type}`,
        source: type === 'DEPOSITO' ? 'BANCO' : 'CAJA', sourceModel: 'CashMovement',
        lines, userId: req.user._id, session,
      });

      const [movement] = await CashMovement.create([{
        clinic: req.clinicId,
        cashSession: open._id,
        date,
        type,
        amount,
        description: description || '',
        counterpartAccount: counterpartAccount?._id || null,
        bankAccount: bank?._id || null,
        journalEntry: entry._id,
        createdBy: req.user._id,
      }], { session });

      // Vincular el asiento al movimiento (sourceRef) y crear el BankTransaction del depósito.
      entry.sourceRef = movement._id;
      await entry.save({ session });

      if (type === 'DEPOSITO' && bank) {
        [bankTx] = await BankTransaction.create([{
          clinic: req.clinicId,
          bankAccount: bank._id,
          date,
          type: 'DEPOSITO',
          amount,
          direction: 1,
          description: description || 'Depósito de caja',
          journalEntry: entry._id,
          sourceModel: 'CashMovement',
          sourceRef: movement._id,
          createdBy: req.user._id,
        }], { session });
        movement.bankTransaction = bankTx._id;
        await movement.save({ session });
      }
      return movement._id;
    });
    const movement = await CashMovement.findById(movementId);
    res.status(201).json(movement);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** Lista los movimientos de la sesión de caja abierta (o de una indicada por ?session=). */
exports.listMovements = async (req, res) => {
  try {
    let sessionId = req.query.session;
    if (!sessionId) {
      const open = await CashClosing.findOne({ clinic: req.clinicId, status: 'ABIERTA', openedBy: req.user._id }).select('_id');
      sessionId = open?._id;
    }
    if (!sessionId) return res.json([]);
    const items = await CashMovement.find({ clinic: req.clinicId, cashSession: sessionId })
      .sort({ date: -1 })
      .populate('counterpartAccount', 'code name')
      .populate('bankAccount', 'name');
    res.json(items);
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
};

/** Anula un movimiento de caja: reversa su asiento y su movimiento bancario. */
exports.voidMovement = async (req, res) => {
  try {
    const { reverseEntry } = require('../utils/accounting');
    const BankTransaction = require('../models/BankTransaction');
    const result = await runInTransaction(async (session) => {
      const mov = await CashMovement.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!mov) throw Object.assign(new Error('Movimiento no encontrado'), { status: 404 });
      if (mov.voided) throw Object.assign(new Error('Ya anulado'), { status: 400 });
      const date = req.body.date ? new Date(req.body.date) : new Date();
      if (mov.journalEntry) {
        await reverseEntry({ clinicId: req.clinicId, entryId: mov.journalEntry, userId: req.user._id, reason: 'Anulación movimiento de caja', date, session });
      }
      if (mov.bankTransaction) {
        const tx = await BankTransaction.findById(mov.bankTransaction).session(session);
        if (tx && !tx.voided) {
          tx.voided = true; tx.voidedAt = date; tx.voidedBy = req.user._id;
          await tx.save({ session });
        }
      }
      mov.voided = true;
      await mov.save({ session });
      return { message: 'Movimiento anulado' };
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};
