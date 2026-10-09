const CreditCardBatch = require('../models/CreditCardBatch');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const CardSettlement = require('../models/CardSettlement');
const Sale = require('../models/Sale');
const Counter = require('../models/Counter');
const { reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { readIdempotencyKey, fingerprint, assertSameFingerprint, normalize: N } = require('../utils/idempotency');
const voucherIdentity = require('../utils/cardVoucherIdentity');

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.status) filter.status = req.query.status;
  const items = await CreditCardBatch.find(filter)
    .populate('bankAccount', 'name')
    .sort({ closeDate: -1 });
  res.json(items);
};

exports.get = async (req, res) => {
  const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('bankAccount', 'name')
    .populate('vouchers.sale', 'saleNumber createdAt');
  if (!b) return res.status(404).json({ message: 'No encontrado' });
  const settled = await CardSettlement.find({ clinic: req.clinicId, batch: b._id, status: 'CONTABILIZADO' })
    .select('sourceSales totalDeposit').lean();
  const usedVouchers = settled.flatMap((item) => item.sourceSales || []);
  const manualSettled = settled.filter((item) => !(item.sourceSales || []).length)
    .reduce((sum, item) => sum + Number(item.totalDeposit || 0), 0);
  const manualGross = (b.vouchers || []).filter((v) => !v.sale)
    .reduce((sum, item) => sum + Number(item.grossAmount || 0), 0);
  res.json({
    ...b.toObject(),
    availableVouchers: (b.vouchers || []).filter((v) => !v.sale || !usedVouchers.some((used) =>
      voucherIdentity.conflicts({ sale: v.sale._id || v.sale, paymentIndex: v.paymentIndex }, used))),
    manualPending: Math.max(0, +(manualGross - manualSettled).toFixed(2)),
  });
};

/**
 * Código secuencial ATÓMICO del lote (antes `countDocuments() + 1`, que con dos peticiones
 * simultáneas emitía el mismo código). Se siembra desde el último lote del año.
 */
async function nextBatchCode(clinicId) {
  const year = new Date().getFullYear();
  const key = `credit-card-batch-${year}`;
  const prefix = `LOTE-${year}-`;
  const existing = await Counter.findOne({ clinic: clinicId, key });
  if (!existing) {
    const last = await CreditCardBatch.findOne({ clinic: clinicId, code: new RegExp(`^${prefix}`) })
      .sort({ code: -1 }).select('code');
    const start = last ? (parseInt(String(last.code).match(/(\d+)$/)?.[1] || '0', 10) || 0) : 0;
    try { await Counter.create({ clinic: clinicId, key, seq: start }); }
    catch (e) { if (e.code !== 11000) throw e; }
  }
  const updated = await Counter.findOneAndUpdate(
    { clinic: clinicId, key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return `${prefix}${String(updated.seq).padStart(5, '0')}`;
}

/** Deja solo los campos del schema y normaliza importes (los vouchers llegan del cliente). */
const cleanVouchers = (vouchers) => (Array.isArray(vouchers) ? vouchers : []).map((v) => ({
  sale: v.sale || null,
  paymentIndex: voucherIdentity.paymentIndex(v.paymentIndex),
  invoice: v.invoice || null,
  voucherNumber: String(v.voucherNumber || '').trim(),
  lote: String(v.lote || '').trim(),
  cardLast4: String(v.cardLast4 || '').trim(),
  cardType: v.cardType || '',
  grossAmount: +(Number(v.grossAmount) || 0).toFixed(2),
  date: v.date || null,
}));

async function validateVouchers(clinicId, vouchers, exceptBatch = null) {
  if (!vouchers.length || vouchers.some((v) => v.grossAmount <= 0)) {
    throw Object.assign(new Error('El lote necesita vouchers con importe positivo'), { status: 400 });
  }
  const saleVouchers = vouchers.filter((v) => v.sale);
  const ids = [...new Set(saleVouchers.map((v) => String(v.sale)))];
  if (saleVouchers.some((v) => Number.isNaN(v.paymentIndex)) ||
      saleVouchers.some((v, i) => saleVouchers.slice(i + 1).some((other) => voucherIdentity.conflicts(v, other)))) {
    throw Object.assign(new Error('Un mismo renglón de tarjeta no puede repetirse dentro del lote'), { status: 409, code: 'CARD_BATCH_DUPLICATE_SALE' });
  }
  if (!ids.length) return;
  const sales = await Sale.find({ _id: { $in: ids }, clinic: clinicId, status: 'completada' })
    .select('paymentMethod payments total');
  if (sales.length !== ids.length) throw Object.assign(new Error('Una venta del lote no existe en esta clínica'), { status: 409, code: 'CARD_BATCH_INVALID_SALE' });
  const byId = new Map(sales.map((sale) => [String(sale._id), sale]));
  for (const voucher of vouchers.filter((v) => v.sale)) {
    const sale = byId.get(String(voucher.sale));
    const cards = (sale.payments || []).map((p, index) => ({ ...p.toObject(), index }))
      .filter((p) => p.method === 'tarjeta');
    if (cards.length > 1 && voucher.paymentIndex === null) {
      throw Object.assign(new Error('Indica el renglón de pago de tarjeta de esta venta'), { status: 409, code: 'CARD_MULTI_VOUCHER_REVIEW' });
    }
    const card = voucher.paymentIndex !== null
      ? cards.find((p) => p.index === voucher.paymentIndex) : cards[0];
    const cardAmount = card ? Number(card.amount || 0)
      : !cards.length && voucher.paymentIndex === null && sale.paymentMethod === 'tarjeta' ? Number(sale.total || 0) : 0;
    if (cardAmount <= 0 || Math.abs(voucher.grossAmount - cardAmount) > 0.01) {
      throw Object.assign(new Error('Una venta no tiene un cobro con tarjeta por el importe del voucher'), { status: 409, code: 'CARD_BATCH_AMOUNT' });
    }
  }
  const usedBatches = await CreditCardBatch.find({
    clinic: clinicId, _id: { $ne: exceptBatch }, status: { $ne: 'ANULADO' },
    'vouchers.sale': { $in: ids },
  }).select('code vouchers');
  const usedBatch = usedBatches.find((b) => b.vouchers.some((used) => saleVouchers.some((v) => voucherIdentity.conflicts(v, used))));
  if (usedBatch) throw Object.assign(new Error(`Un voucher ya pertenece al lote ${usedBatch.code}`), { status: 409, code: 'CARD_BATCH_SALE_USED' });
  const usedSettlements = await CardSettlement.find({
    clinic: clinicId, status: 'CONTABILIZADO', 'sourceSales.sale': { $in: ids },
  }).select('code sourceSales');
  const usedSettlement = usedSettlements.find((s) => s.sourceSales.some((used) => saleVouchers.some((v) => voucherIdentity.conflicts(v, used))));
  if (usedSettlement) throw Object.assign(new Error(`Un voucher ya fue liquidado en ${usedSettlement.code}`), { status: 409, code: 'CARD_SALE_SETTLED' });
}

/** Recalcula comisión, IVA de la comisión, retención y neto a partir de los vouchers. */
function recomputeBatch(b) {
  const grossAmount = +(b.vouchers || []).reduce((s, v) => s + (Number(v.grossAmount) || 0), 0).toFixed(2);
  // El % de IVA lo pone el formulario (antes estaba fijo en 15 aquí dentro y el campo de la
  // pantalla no tenía ningún efecto). Si no viene, 15.
  const ivaRate = b.ivaCommissionRate === undefined || b.ivaCommissionRate === null ? 15 : Number(b.ivaCommissionRate) || 0;
  b.grossAmount = grossAmount;
  b.ivaCommissionRate = ivaRate;
  b.commissionAmount = +(grossAmount * (b.commissionRate || 0) / 100).toFixed(2);
  b.ivaCommissionAmount = +(b.commissionAmount * ivaRate / 100).toFixed(2);
  b.retentionAmount = +(grossAmount * (b.retentionRate || 0) / 100).toFixed(2);
  b.netAmount = +(grossAmount - b.commissionAmount - b.ivaCommissionAmount - b.retentionAmount).toFixed(2);
}

/** Crea el lote. IDEMPOTENTE por `Idempotency-Key`: el doble clic no crea dos lotes. */
exports.create = async (req, res) => {
  const idemKey = readIdempotencyKey(req);
  const body = req.body || {};
  const vouchers = cleanVouchers(body.vouchers);
  const idemFingerprint = fingerprint({
    op: 'creditCardBatch.create',
    closeDate: N.date(body.closeDate),
    acquirer: body.acquirer || null,
    cardType: body.cardType || null,
    commissionRate: N.num(body.commissionRate),
    retentionRate: N.num(body.retentionRate),
    ivaCommissionRate: N.num(body.ivaCommissionRate),
    bankAccount: N.id(body.bankAccount),
    vouchers: vouchers.map((v) => ({ sale: N.id(v.sale), paymentIndex: v.paymentIndex,
      voucherNumber: v.voucherNumber, lote: v.lote, grossAmount: N.num(v.grossAmount) })),
  });
  try {
    if (idemKey) {
      const previo = await CreditCardBatch.findOne({ clinic: req.clinicId, idempotencyKey: idemKey });
      if (previo) {
        assertSameFingerprint(previo.idempotencyFingerprint, idemFingerprint, 'lote de tarjetas');
        return res.json({ ...previo.toObject(), idempotentReplay: true });
      }
    }
    await validateVouchers(req.clinicId, vouchers);
    const code = await nextBatchCode(req.clinicId);
    const draft = {
      ...body, clinic: req.clinicId, code, vouchers,
      commissionRate: Number(body.commissionRate) || 0,
      retentionRate: Number(body.retentionRate) || 0,
      ivaCommissionRate: body.ivaCommissionRate === undefined ? 15 : Number(body.ivaCommissionRate) || 0,
      bankAccount: body.bankAccount || null,
      idempotencyKey: idemKey,
      idempotencyFingerprint: idemKey ? idemFingerprint : null,
      createdBy: req.user._id,
    };
    recomputeBatch(draft);
    const b = await CreditCardBatch.create(draft);
    res.status(201).json(b);
  } catch (e) {
    if (e.code === 11000 && idemKey) {
      const previo = await CreditCardBatch.findOne({ clinic: req.clinicId, idempotencyKey: idemKey });
      if (previo) {
        try { assertSameFingerprint(previo.idempotencyFingerprint, idemFingerprint, 'lote de tarjetas'); }
        catch (c) { return res.status(409).json({ message: c.message }); }
        return res.json({ ...previo.toObject(), idempotentReplay: true });
      }
    }
    if (e.code === 11000 && e.keyPattern?.['vouchers.sale']) {
      return res.status(409).json({ code: 'CARD_BATCH_SALE_USED', message: 'Este voucher ya pertenece a otro lote vigente' });
    }
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!b) return res.status(404).json({ message: 'No encontrado' });
    if (b.status !== 'ABIERTO') return res.status(400).json({ message: 'No editable' });
    const { code, status, clinic, journalEntry, bankTransaction, idempotencyKey, idempotencyFingerprint, ...rest } = req.body;
    const nextVouchers = rest.vouchers !== undefined ? cleanVouchers(rest.vouchers) : b.vouchers;
    await validateVouchers(req.clinicId, nextVouchers, b._id);
    Object.assign(b, rest);
    if (rest.vouchers !== undefined) b.vouchers = nextVouchers;
    recomputeBatch(b);
    await b.save();
    res.json(b);
  } catch (e) {
    if (e.code === 11000 && e.keyPattern?.['vouchers.sale']) {
      return res.status(409).json({ code: 'CARD_BATCH_SALE_USED', message: 'Este voucher ya pertenece a otro lote vigente' });
    }
    res.status(e.status || 400).json({ message: e.message });
  }
};

/** Los lotes solo agrupan vouchers; la acreditación económica ocurre en CardSettlement. */
exports.liquidate = async (req, res) => {
  const batch = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId }).select('_id');
  if (!batch) return res.status(404).json({ message: 'Lote no encontrado' });
  return res.status(409).json({
    code: 'SETTLEMENT_REQUIRED',
    message: 'Registra una nueva liquidación para este lote. El lote no crea un segundo depósito bancario.',
    batch: batch._id,
  });
};

exports.cancel = async (req, res) => {
  try {
    {
      const batchId = await runInTransaction(async (session) => {
        const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!b) throw Object.assign(new Error('No encontrado'), { status: 404 });
        if (b.status === 'ANULADO') throw Object.assign(new Error('Ya anulado'), { status: 400 });
        const activeSettlements = await CardSettlement.countDocuments({ clinic: req.clinicId, batch: b._id, status: { $ne: 'ANULADO' } }).session(session);
        if (activeSettlements) throw Object.assign(new Error('Anula primero las liquidaciones vinculadas a este lote'), { status: 409, code: 'CARD_BATCH_HAS_SETTLEMENTS' });
        const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
        await assertPeriodOpen(req.clinicId, reversalDate, { session });
        if (b.journalEntry) {
          await reverseEntry({
            clinicId: req.clinicId,
            entryId: b.journalEntry,
            userId: req.user._id,
            reason: 'Anulacion lote',
            date: reversalDate,
            session,
          });
        }
        if (b.bankTransaction) {
          const tx = await BankTransaction.findById(b.bankTransaction).session(session);
          if (tx && !tx.voided) {
            if (tx.reconciled) throw Object.assign(new Error('El depósito del lote está conciliado: reabre la conciliación antes de anularlo'), { status: 409, code: 'BANK_RECONCILED' });
            tx.voided = true;
            tx.voidedAt = reversalDate;
            tx.voidedBy = req.user._id;
            tx.voidReason = req.body?.reason || 'Anulacion lote';
            await tx.save({ session });
            await BankAccount.updateOne(
              { _id: tx.bankAccount },
              { $inc: { bookBalance: -(Number(tx.amount || 0) * Number(tx.direction || 0)) } },
              { session }
            );
          }
        }
        b.status = 'ANULADO';
        await b.save({ session });
        return b._id;
      });
      const batch = await CreditCardBatch.findById(batchId).populate('bankAccount', 'name');
      return res.json(batch);
    }
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};
