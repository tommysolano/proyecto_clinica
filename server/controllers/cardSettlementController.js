const CardSettlement = require('../models/CardSettlement');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const ChartOfAccount = require('../models/ChartOfAccount');
const Sale = require('../models/Sale');
const { createEntry, findAccount, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');

const round = (n) => +(Number(n) || 0).toFixed(2);
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Busca ventas pagadas con tarjeta para cargarlas en una liquidación.
 * Filtra por N° de lote y/o rango de fechas (y opcionalmente POS / tarjeta).
 * Por defecto excluye las ventas ya incluidas en otra liquidación no anulada
 * para evitar liquidar dos veces la misma factura.
 */
exports.searchCardSales = async (req, res) => {
  try {
    const { lote, from, to, cardPos, creditCard, includeSettled } = req.query;
    const filter = { clinic: req.clinicId, paymentMethod: 'tarjeta', status: 'completada' };
    if (lote && lote.trim()) filter.cardLote = new RegExp(`^${escapeRegex(lote.trim())}$`, 'i');
    if (cardPos) filter.cardPos = cardPos;
    if (creditCard) filter.creditCard = creditCard;
    if (from || to) {
      filter.createdAt = {};
      if (from) filter.createdAt.$gte = new Date(`${from}T00:00:00.000`);
      if (to) filter.createdAt.$lte = new Date(`${to}T23:59:59.999`);
    }
    if (!includeSettled || includeSettled === 'false') {
      const used = await CardSettlement.distinct('sourceSales.sale', { clinic: req.clinicId, status: { $ne: 'ANULADO' } });
      if (used.length) filter._id = { $nin: used };
    }
    const sales = await Sale.find(filter)
      .select('saleNumber clientName total createdAt cardLote cardVoucher cardPos creditCard invoice')
      .populate('creditCard', 'name brand')
      .sort({ createdAt: 1 })
      .limit(500);
    res.json(sales);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Recalcula los totales de la liquidación a partir de sus transacciones y
 * retenciones. El "a pagar" de cada transacción se deriva para mantener el
 * cuadre contable: aPagar = deposito - comisión - iva - retIva.
 */
function computeTotals(doc) {
  let totalDeposit = 0, totalCommission = 0, totalIva = 0, totalRetIva = 0, totalToPay = 0;
  (doc.transactions || []).forEach((t) => {
    const deposit = Number(t.deposit) || 0;
    const commission = Number(t.commission) || 0;
    const iva = Number(t.iva) || 0;
    const retIva = Number(t.retIva) || 0;
    t.toPay = round(deposit - commission - iva - retIva);
    totalDeposit += deposit;
    totalCommission += commission;
    totalIva += iva;
    totalRetIva += retIva;
    totalToPay += t.toPay;
  });
  const totalRetIr = (doc.retentions || [])
    .filter((r) => r.type === 'RENTA')
    .reduce((s, r) => s + (Number(r.value) || 0), 0);
  doc.totalDeposit = round(totalDeposit);
  doc.totalCommission = round(totalCommission);
  doc.totalIva = round(totalIva);
  doc.totalRetIva = round(totalRetIva);
  doc.totalRetIr = round(totalRetIr);
  doc.totalToPay = round(totalToPay);
}

/** Resuelve una cuenta: usa la seleccionada, o el rol del mapa de cuentas configurable. */
async function resolveAccount(clinicId, selectedId, role, session) {
  if (selectedId) {
    const acc = await ChartOfAccount.findOne({ _id: selectedId, clinic: clinicId }).session(session || null);
    if (acc) return acc;
  }
  return getAccount(clinicId, role, { session });
}

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.status) filter.status = req.query.status;
  const items = await CardSettlement.find(filter)
    .populate('supplier', 'razonSocial nombreComercial')
    .populate('bankAccount', 'name')
    .sort({ issueDate: -1, createdAt: -1 });
  res.json(items);
};

exports.get = async (req, res) => {
  const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('supplier', 'razonSocial nombreComercial ruc')
    .populate('bankAccount', 'name')
    .populate('transactions.account', 'code name')
    .populate('transactions.costCenter', 'code name');
  if (!s) return res.status(404).json({ message: 'No encontrada' });
  res.json(s);
};

exports.create = async (req, res) => {
  try {
    const count = await CardSettlement.countDocuments({ clinic: req.clinicId });
    const code = `LIQ-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
    const s = new CardSettlement({ ...req.body, clinic: req.clinicId, code, createdBy: req.user._id });
    computeTotals(s);
    await s.save();
    res.status(201).json(s);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.update = async (req, res) => {
  try {
    const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!s) return res.status(404).json({ message: 'No encontrada' });
    if (s.status !== 'BORRADOR') return res.status(400).json({ message: 'Solo se editan liquidaciones en BORRADOR' });
    const { code, status, journalEntry, bankTransaction, clinic, ...rest } = req.body;
    Object.assign(s, rest);
    computeTotals(s);
    await s.save();
    res.json(s);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/**
 * Acredita / contabiliza la liquidación: registra el depósito neto en el banco,
 * la comisión (con centro de costo por transacción), el IVA de la comisión, las
 * retenciones por cobrar y cancela las tarjetas por cobrar.
 */
exports.accredit = async (req, res) => {
  try {
    {
      const settlementId = await runInTransaction(async (session) => {
        const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!s) throw Object.assign(new Error('No encontrada'), { status: 404 });
        if (s.status !== 'BORRADOR') throw Object.assign(new Error('No esta en BORRADOR'), { status: 400 });
        if (!s.bankAccount) throw Object.assign(new Error('Selecciona el banco donde se acredita'), { status: 400 });

        computeTotals(s);
        const accreditedAt = req.body.accreditedAt ? new Date(req.body.accreditedAt) : (s.issueDate || new Date());
        await assertPeriodOpen(req.clinicId, accreditedAt, { session });
        const bank = await BankAccount.findOne({ _id: s.bankAccount, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
        const bankAcc = await ChartOfAccount.findOne({ _id: bank.chartAccount, clinic: req.clinicId }).session(session);
        if (!bankAcc) throw Object.assign(new Error('La cuenta bancaria no tiene cuenta contable asociada'), { status: 400 });

        const receivable = await resolveAccount(req.clinicId, s.receivableAccount, 'tarjetasPorLiquidar', session);
        const commissionAcc = await resolveAccount(req.clinicId, s.commissionAccount, 'comisionTarjeta', session);
        const ivaAcc = s.totalIva > 0 ? await resolveAccount(req.clinicId, s.ivaAccount, 'ivaCompras', session) : null;
        const retIvaAcc = s.totalRetIva > 0 ? await resolveAccount(req.clinicId, s.retIvaAccount, 'retIvaPorCobrar', session) : null;
        const retIrAcc = s.totalRetIr > 0 ? await resolveAccount(req.clinicId, s.retIrAccount, 'retRentaPorCobrar', session) : null;

        const netToBank = round(s.totalToPay - s.totalRetIr);
        const lines = [];
        if (netToBank > 0) lines.push({ account: bankAcc._id, debit: netToBank, credit: 0, description: `Acreditacion liquidacion ${s.code}` });
        (s.transactions || []).forEach((t) => {
          if ((Number(t.commission) || 0) > 0) {
            lines.push({
              account: commissionAcc._id,
              costCenter: t.costCenter || null,
              debit: round(t.commission),
              credit: 0,
              description: `Comision tarjeta ${t.recap ? '#' + t.recap : ''}`.trim(),
            });
          }
        });
        if (s.totalIva > 0 && ivaAcc) lines.push({ account: ivaAcc._id, debit: s.totalIva, credit: 0, description: 'IVA comision' });
        if (s.totalRetIva > 0 && retIvaAcc) lines.push({ account: retIvaAcc._id, debit: s.totalRetIva, credit: 0, description: 'Retencion IVA por cobrar' });
        if (s.totalRetIr > 0 && retIrAcc) lines.push({ account: retIrAcc._id, debit: s.totalRetIr, credit: 0, description: 'Retencion IR por cobrar' });
        if (s.totalDeposit > 0) lines.push({ account: receivable._id, debit: 0, credit: s.totalDeposit, description: 'Cancelacion tarjetas por cobrar' });

        const [bt] = await BankTransaction.create([{
          clinic: req.clinicId,
          bankAccount: bank._id,
          date: accreditedAt,
          type: 'DEPOSITO',
          amount: netToBank,
          direction: 1,
          description: `Liquidacion tarjetas ${s.code}`,
          reference: s.docNumber || s.code,
          sourceModel: 'CardSettlement',
          sourceRef: s._id,
          createdBy: req.user._id,
        }], { session });
        const entry = await createEntry({
          clinicId: req.clinicId,
          date: accreditedAt,
          description: `Liquidacion tarjetas ${s.code}`,
          source: 'TARJETA',
          sourceRef: s._id,
          sourceModel: 'CardSettlement',
          sourceAction: 'ACCREDIT',
          lines,
          userId: req.user._id,
          session,
        });
        bt.journalEntry = entry._id;
        await bt.save({ session });
        s.status = 'CONTABILIZADO';
        s.accreditedAt = accreditedAt;
        s.journalEntry = entry._id;
        s.bankTransaction = bt._id;
        await s.save({ session });
        const saleIds = (s.sourceSales || []).map((x) => x.sale).filter(Boolean);
        if (saleIds.length) {
          await Sale.updateMany(
            { _id: { $in: saleIds }, clinic: req.clinicId },
            { cardSettlement: s._id },
            { session }
          );
        }
        return s._id;
      });
      const settlement = await CardSettlement.findById(settlementId);
      return res.json(settlement);
    }
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.cancel = async (req, res) => {
  try {
    {
      const settlementId = await runInTransaction(async (session) => {
        const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!s) throw Object.assign(new Error('No encontrada'), { status: 404 });
        if (s.status === 'ANULADO') throw Object.assign(new Error('Ya esta anulada'), { status: 400 });
        const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, reversalDate, { session });
        if (s.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: s.journalEntry,
            userId: req.user._id,
            reason: 'Anulacion liquidacion tarjeta',
            date: reversalDate,
            session,
          });
        }
        if (s.bankTransaction) {
          const tx = await BankTransaction.findById(s.bankTransaction).session(session);
          if (tx && !tx.voided) {
            tx.voided = true;
            tx.voidedAt = reversalDate;
            tx.voidedBy = req.user._id;
            tx.voidReason = req.body?.reason || 'Anulacion liquidacion tarjeta';
            await tx.save({ session });
            await BankAccount.updateOne(
              { _id: tx.bankAccount },
              { $inc: { bookBalance: -(Number(tx.amount || 0) * Number(tx.direction || 0)) } },
              { session }
            );
          }
        }
        s.status = 'ANULADO';
        await s.save({ session });
        const saleIds = (s.sourceSales || []).map((x) => x.sale).filter(Boolean);
        if (saleIds.length) {
          await Sale.updateMany(
            { _id: { $in: saleIds }, cardSettlement: s._id },
            { cardSettlement: null },
            { session }
          );
        }
        return s._id;
      });
      const settlement = await CardSettlement.findById(settlementId);
      return res.json(settlement);
    }
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.remove = async (req, res) => {
  try {
    const s = await CardSettlement.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!s) return res.status(404).json({ message: 'No encontrada' });
    if (s.status === 'CONTABILIZADO') return res.status(400).json({ message: 'Anula la liquidación antes de eliminarla' });
    await s.deleteOne();
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
