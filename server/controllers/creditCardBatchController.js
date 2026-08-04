const CreditCardBatch = require('../models/CreditCardBatch');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Counter = require('../models/Counter');
const { createEntry, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { readIdempotencyKey, fingerprint, assertSameFingerprint, normalize: N } = require('../utils/idempotency');

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
    .populate('bankAccount', 'name');
  if (!b) return res.status(404).json({ message: 'No encontrado' });
  res.json(b);
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
  invoice: v.invoice || null,
  voucherNumber: String(v.voucherNumber || '').trim(),
  lote: String(v.lote || '').trim(),
  cardLast4: String(v.cardLast4 || '').trim(),
  cardType: v.cardType || '',
  grossAmount: +(Number(v.grossAmount) || 0).toFixed(2),
  date: v.date || null,
}));

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
    vouchers: vouchers.map((v) => ({ voucherNumber: v.voucherNumber, lote: v.lote, grossAmount: N.num(v.grossAmount) })),
  });
  try {
    if (idemKey) {
      const previo = await CreditCardBatch.findOne({ clinic: req.clinicId, idempotencyKey: idemKey });
      if (previo) {
        assertSameFingerprint(previo.idempotencyFingerprint, idemFingerprint, 'lote de tarjetas');
        return res.json({ ...previo.toObject(), idempotentReplay: true });
      }
    }
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
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.update = async (req, res) => {
  try {
    const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!b) return res.status(404).json({ message: 'No encontrado' });
    if (b.status !== 'ABIERTO') return res.status(400).json({ message: 'No editable' });
    const { code, status, clinic, journalEntry, bankTransaction, idempotencyKey, idempotencyFingerprint, ...rest } = req.body;
    Object.assign(b, rest);
    if (rest.vouchers !== undefined) b.vouchers = cleanVouchers(rest.vouchers);
    recomputeBatch(b);
    await b.save();
    res.json(b);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/** Liquida: registra depósito en banco real, gasto comisión + IVA, retención por cobrar, y descarga "tarjetas por liquidar". */
exports.liquidate = async (req, res) => {
  try {
    const { bankAccount, liquidationDate } = req.body;
    {
      const batchId = await runInTransaction(async (session) => {
        const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!b) throw Object.assign(new Error('No encontrado'), { status: 404 });
        if (b.status !== 'ABIERTO') throw Object.assign(new Error('No es ABIERTO'), { status: 400 });
        const txDate = liquidationDate ? new Date(liquidationDate) : new Date();
        await assertPeriodOpen(req.clinicId, txDate, { session });
        // El banco es el que se envía o, si no viene, el que se eligió al crear el lote.
        // Sin esta guardia el filtro quedaba `{ clinic }` (mongoose descarta las claves
        // `undefined`) y el depósito caía en la PRIMERA cuenta de la clínica, no en la elegida.
        const bankId = bankAccount || b.bankAccount;
        if (!bankId) throw Object.assign(new Error('Selecciona el banco donde se acredita el lote'), { status: 400 });
        const bank = await BankAccount.findOne({ _id: bankId, clinic: req.clinicId }).session(session);
        if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });

        const ChartOfAccount = require('../models/ChartOfAccount');
        const bankAcc = await ChartOfAccount.findOne({ _id: bank.chartAccount, clinic: req.clinicId }).session(session);
        if (!bankAcc) throw Object.assign(new Error('La cuenta bancaria no tiene cuenta contable asociada'), { status: 400 });
        const tarjetasXliq = await getAccount(req.clinicId, 'tarjetasPorLiquidar', { session });
        const comision = await getAccount(req.clinicId, 'comisionTarjeta', { session });
        const ivaCompras = await getAccount(req.clinicId, 'ivaCompras', { session });
        const retXcobrar = await getAccount(req.clinicId, 'retRentaPorCobrar', { session });

        const lines = [];
        if (b.netAmount > 0) lines.push({ account: bankAcc._id, debit: b.netAmount, credit: 0, description: `Deposito liquidacion ${b.code}` });
        if (b.commissionAmount > 0) lines.push({ account: comision._id, debit: b.commissionAmount, credit: 0, description: 'Comision tarjeta' });
        if (b.ivaCommissionAmount > 0 && ivaCompras) lines.push({ account: ivaCompras._id, debit: b.ivaCommissionAmount, credit: 0, description: 'IVA comision' });
        if (b.retentionAmount > 0) lines.push({ account: retXcobrar._id, debit: b.retentionAmount, credit: 0, description: 'Retencion por cobrar' });
        if (b.grossAmount > 0) lines.push({ account: tarjetasXliq._id, debit: 0, credit: b.grossAmount, description: 'Cancelacion tarjetas por liquidar' });

        const [bt] = await BankTransaction.create([{
          clinic: req.clinicId,
          bankAccount: bank._id,
          date: txDate,
          type: 'DEPOSITO',
          amount: b.netAmount,
          direction: 1,
          description: `Liquidacion tarjetas ${b.code}`,
          reference: b.code,
          sourceModel: 'CreditCardBatch',
          sourceRef: b._id,
          createdBy: req.user._id,
        }], { session });
        const entry = await createEntry({
          clinicId: req.clinicId,
          date: txDate,
          description: `Liquidacion tarjetas ${b.code}`,
          source: 'TARJETA',
          sourceRef: b._id,
          sourceModel: 'CreditCardBatch',
          sourceAction: 'LIQUIDATE',
          lines,
          userId: req.user._id,
          session,
        });
        bt.journalEntry = entry._id;
        await bt.save({ session });
        b.status = 'LIQUIDADO';
        b.liquidationDate = txDate;
        b.bankAccount = bank._id;
        b.journalEntry = entry._id;
        b.bankTransaction = bt._id;
        await b.save({ session });
        return b._id;
      });
      const batch = await CreditCardBatch.findById(batchId).populate('bankAccount', 'name');
      return res.json(batch);
    }
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.cancel = async (req, res) => {
  try {
    {
      const batchId = await runInTransaction(async (session) => {
        const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
        if (!b) throw Object.assign(new Error('No encontrado'), { status: 404 });
        if (b.status === 'ANULADO') throw Object.assign(new Error('Ya anulado'), { status: 400 });
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
