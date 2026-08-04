const CashDeposit = require('../models/CashDeposit');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Counter = require('../models/Counter');
const ChartOfAccount = require('../models/ChartOfAccount');
const { createEntry, reverseEntry, runInTransaction, assertPeriodOpen } = require('../utils/accounting');
const { getAccount } = require('../utils/accountMap');
const { normalizeSalePayments } = require('../services/salePayments');
const {
  readIdempotencyKey, fingerprint, assertSameFingerprint, normalize: N,
} = require('../utils/idempotency');

/**
 * DEPÓSITOS DE EFECTIVO — lo que se lleva a ventanilla.
 *
 * Qué resuelve: el contador no tenía dónde ver los depósitos hechos. Existía un botón suelto en
 * Caja que movía el dinero, pero no dejaba documento: no había listado, ni detalle de qué
 * facturas componían el depósito, ni forma de anularlo. Peor: para no volver a ofrecer una venta
 * ya depositada le CAMBIABA la forma de pago a 'transferencia', con lo que la venta mentía sobre
 * cómo se cobró (y con ella el Excel de ventas y los reportes por forma de pago). Aquí el
 * depósito es un documento propio y la venta solo queda marcada con `cashDeposit`.
 *
 * Solo entra EFECTIVO: las ventas cobradas por transferencia ya están en el banco y las de
 * tarjeta viven en «tarjetas por liquidar» hasta que el adquirente acredita.
 */

const round2 = (n) => +Number(n || 0).toFixed(2);
const escaparRegex = (v) => String(v).trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Numeración atómica por clínica y año (misma técnica que liquidaciones y lotes). */
async function nextDepositNumber(clinicId, session) {
  const year = new Date().getFullYear();
  const key = `cash-deposit-${year}`;
  const prefix = `DEP-${year}-`;
  const existing = await Counter.findOne({ clinic: clinicId, key }).session(session || null);
  if (!existing) {
    const last = await CashDeposit.findOne({ clinic: clinicId, number: new RegExp(`^${prefix}`) })
      .sort({ number: -1 }).select('number').session(session || null);
    const start = last ? (parseInt(String(last.number).match(/(\d+)$/)?.[1] || '0', 10) || 0) : 0;
    try { await Counter.create([{ clinic: clinicId, key, seq: start }], { session: session || undefined }); }
    catch (e) { if (e.code !== 11000) throw e; }
  }
  const updated = await Counter.findOneAndUpdate(
    { clinic: clinicId, key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, session: session || undefined }
  );
  return `${prefix}${String(updated.seq).padStart(5, '0')}`;
}

/** Parte EN EFECTIVO de una venta (en una venta mixta no es su total). */
function efectivoDeVenta(sale) {
  const { rows } = normalizeSalePayments(sale);
  return round2(rows.filter((r) => r.method === 'efectivo').reduce((s, r) => s + r.amount, 0));
}

/**
 * Efectivo pendiente de depositar hasta una fecha de corte: ventas del mostrador cobradas
 * (total o parcialmente) en efectivo y cobros de cartera en efectivo, que todavía no entraron
 * en ningún depósito.
 *
 * GET /cash-deposits/pending?cutDate=&startDate=
 */
exports.pending = async (req, res) => {
  try {
    const hasta = req.query.cutDate
      ? new Date(`${String(req.query.cutDate).slice(0, 10)}T23:59:59.999`)
      : null;
    const desde = req.query.startDate ? new Date(req.query.startDate) : null;

    const rangoVenta = {};
    if (desde) rangoVenta.$gte = desde;
    if (hasta) rangoVenta.$lte = hasta;

    const filtroVenta = {
      clinic: req.clinicId,
      status: 'completada',
      cashDeposit: null,
      // Venta de contado en efectivo o venta mixta con una parte en efectivo.
      $or: [{ paymentMethod: 'efectivo' }, { 'payments.method': 'efectivo' }],
    };
    if (desde || hasta) filtroVenta.createdAt = rangoVenta;

    const filtroCobro = {
      clinic: req.clinicId,
      type: 'COBRO',
      method: 'EFECTIVO',
      status: 'REGISTRADO',
      cashDeposit: null,
    };
    if (desde || hasta) filtroCobro.date = rangoVenta;

    const [ventas, cobros] = await Promise.all([
      Sale.find(filtroVenta)
        .select('saleNumber createdAt clientName total paymentMethod payments patient')
        .populate('patient', 'firstName lastName')
        .sort({ createdAt: 1 })
        .limit(2000)
        .lean(),
      Payment.find(filtroCobro)
        .select('number date partyName total')
        .sort({ date: 1 })
        .limit(2000)
        .lean(),
    ]);

    const items = [
      ...ventas.map((s) => ({
        docModel: 'Sale',
        docRef: s._id,
        number: s.saleNumber || '',
        docDate: s.createdAt,
        party: s.clientName || [s.patient?.firstName, s.patient?.lastName].filter(Boolean).join(' ') || '',
        total: round2(s.total),
        amount: efectivoDeVenta(s),
        mixta: s.paymentMethod === 'mixto',
      })).filter((x) => x.amount > 0.005),
      ...cobros.map((p) => ({
        docModel: 'Payment',
        docRef: p._id,
        number: p.number,
        docDate: p.date,
        party: p.partyName || '',
        total: round2(p.total),
        amount: round2(p.total),
        mixta: false,
      })),
    ].sort((a, b) => new Date(a.docDate) - new Date(b.docDate));

    res.json({ items, total: round2(items.reduce((s, i) => s + i.amount, 0)), count: items.length });
  } catch (e) {
    res.status(500).json({ message: 'Error al listar el efectivo pendiente de depósito', error: e.message });
  }
};

/** Listado de depósitos registrados. Filtros: banco, rango de fechas, estado y texto libre. */
exports.list = async (req, res) => {
  try {
    const { bankAccount, startDate, endDate, status, q } = req.query;
    const filter = { clinic: req.clinicId };
    if (bankAccount) filter.bankAccount = bankAccount;
    if (status) filter.status = status;
    if (q && q.trim()) {
      const rx = new RegExp(escaparRegex(q), 'i');
      filter.$or = [{ number: rx }, { voucherNumber: rx }, { description: rx }];
    }
    if (startDate || endDate) {
      filter.date = {};
      if (startDate) filter.date.$gte = new Date(startDate);
      if (endDate) filter.date.$lte = new Date(`${String(endDate).slice(0, 10)}T23:59:59.999`);
    }
    const items = await CashDeposit.find(filter)
      .populate('bankAccount', 'name bank accountNumber')
      .populate('createdBy', 'name')
      .sort({ date: -1, createdAt: -1 })
      .limit(500);
    const total = round2(items.filter((d) => d.status !== 'ANULADO').reduce((s, d) => s + Number(d.total || 0), 0));
    res.json({ items, total, count: items.length });
  } catch (e) {
    res.status(500).json({ message: 'Error al listar depósitos', error: e.message });
  }
};

exports.get = async (req, res) => {
  const d = await CashDeposit.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('bankAccount', 'name bank accountNumber')
    .populate('createdBy', 'name')
    .populate('journalEntry', 'number date');
  if (!d) return res.status(404).json({ message: 'Depósito no encontrado' });
  res.json(d);
};

/**
 * Registra el depósito: mueve el efectivo de Caja al banco (débito banco / crédito caja), deja
 * el movimiento en el libro de bancos con su papeleta y marca los documentos incluidos.
 *
 * Body: { date, bankAccount, voucherNumber, description, items: [{docModel, docRef}] }
 */
exports.create = async (req, res) => {
  const idempotencyKey = readIdempotencyKey(req);
  const idemFingerprint = fingerprint({
    op: 'cashDeposit.create',
    bankAccount: N.id(req.body?.bankAccount),
    voucher: req.body?.voucherNumber || null,
    date: N.date(req.body?.date),
    docs: (req.body?.items || []).map((i) => `${i.docModel}:${N.id(i.docRef)}`).sort(),
  });
  try {
    if (idempotencyKey) {
      const existing = await CashDeposit.findOne({ clinic: req.clinicId, idempotencyKey });
      if (existing) {
        assertSameFingerprint(existing.idempotencyFingerprint, idemFingerprint, 'depósito');
        return res.status(200).json({ ...existing.toObject(), idempotentReplay: true });
      }
    }

    const depositId = await runInTransaction(async (session) => {
      const { bankAccount, voucherNumber, description } = req.body;
      const seleccion = Array.isArray(req.body.items) ? req.body.items : [];
      if (!bankAccount) throw Object.assign(new Error('Selecciona la cuenta bancaria del depósito'), { status: 400 });
      if (!String(voucherNumber || '').trim()) {
        throw Object.assign(new Error('El número de papeleta del banco es obligatorio: es el amarre con el estado de cuenta.'), { status: 400 });
      }
      if (!seleccion.length) throw Object.assign(new Error('Selecciona al menos un documento en efectivo'), { status: 400 });

      const txDate = req.body.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, txDate, { session });

      const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId }).session(session);
      if (!bank) throw Object.assign(new Error('Cuenta bancaria no encontrada'), { status: 404 });
      if (!bank.chartAccount) throw Object.assign(new Error('La cuenta bancaria no tiene cuenta contable asociada'), { status: 400 });

      // Se recalcula el importe de CADA documento en el servidor: lo que manda el navegador
      // sirve para saber QUÉ se deposita, nunca CUÁNTO.
      const items = [];
      for (const sel of seleccion) {
        if (sel.docModel === 'Sale') {
          const s = await Sale.findOne({ _id: sel.docRef, clinic: req.clinicId, status: 'completada' }).session(session);
          if (!s) throw Object.assign(new Error('Una de las ventas seleccionadas ya no está disponible'), { status: 400 });
          if (s.cashDeposit) throw Object.assign(new Error(`La venta ${s.saleNumber} ya fue depositada`), { status: 400 });
          const efectivo = efectivoDeVenta(s);
          if (efectivo <= 0.005) throw Object.assign(new Error(`La venta ${s.saleNumber} no tiene cobro en efectivo`), { status: 400 });
          items.push({
            docModel: 'Sale', docRef: s._id, number: s.saleNumber || '',
            docDate: s.createdAt, party: s.clientName || '', amount: efectivo,
          });
        } else if (sel.docModel === 'Payment') {
          const p = await Payment.findOne({
            _id: sel.docRef, clinic: req.clinicId, type: 'COBRO', method: 'EFECTIVO', status: 'REGISTRADO',
          }).session(session);
          if (!p) throw Object.assign(new Error('Uno de los cobros seleccionados ya no está disponible'), { status: 400 });
          if (p.cashDeposit) throw Object.assign(new Error(`El cobro ${p.number} ya fue depositado`), { status: 400 });
          items.push({
            docModel: 'Payment', docRef: p._id, number: p.number,
            docDate: p.date, party: p.partyName || '', amount: round2(p.total),
          });
        } else {
          throw Object.assign(new Error('Documento no válido para un depósito de efectivo'), { status: 400 });
        }
      }

      const total = round2(items.reduce((s, i) => s + i.amount, 0));
      if (total <= 0) throw Object.assign(new Error('El depósito no puede ser de cero'), { status: 400 });

      const number = await nextDepositNumber(req.clinicId, session);
      const [deposit] = await CashDeposit.create([{
        clinic: req.clinicId,
        number,
        date: txDate,
        bankAccount: bank._id,
        voucherNumber: String(voucherNumber).trim(),
        description: description || `Depósito de efectivo ${number}`,
        items,
        total,
        idempotencyKey,
        idempotencyFingerprint: idempotencyKey ? idemFingerprint : null,
        createdBy: req.user._id,
      }], { session });

      const caja = await getAccount(req.clinicId, 'caja', { session });
      const bankChart = await ChartOfAccount.findById(bank.chartAccount).session(session);
      const entry = await createEntry({
        clinicId: req.clinicId,
        date: txDate,
        description: `${deposit.description} — papeleta ${deposit.voucherNumber}`,
        source: 'BANCO',
        sourceModel: 'CashDeposit',
        sourceRef: deposit._id,
        sourceAction: 'DEPOSIT',
        lines: [
          { account: bankChart._id, debit: total, credit: 0, description: `Depósito ${number}` },
          { account: caja._id, debit: 0, credit: total, description: `Depósito ${number}` },
        ],
        userId: req.user._id,
        session,
      });

      const [tx] = await BankTransaction.create([{
        clinic: req.clinicId,
        bankAccount: bank._id,
        date: txDate,
        type: 'DEPOSITO',
        amount: total,
        direction: 1,
        description: deposit.description,
        reference: deposit.voucherNumber,
        voucherNumber: deposit.voucherNumber,
        journalEntry: entry._id,
        sourceModel: 'CashDeposit',
        sourceRef: deposit._id,
        createdBy: req.user._id,
      }], { session });

      deposit.journalEntry = entry._id;
      deposit.bankTransaction = tx._id;
      await deposit.save({ session });

      // Se marcan los documentos: ni la venta ni el cobro vuelven a ofrecerse para depositar.
      // NO se les toca la forma de pago: siguen siendo cobros en efectivo.
      const ventas = items.filter((i) => i.docModel === 'Sale').map((i) => i.docRef);
      const pagos = items.filter((i) => i.docModel === 'Payment').map((i) => i.docRef);
      if (ventas.length) {
        await Sale.updateMany({ _id: { $in: ventas }, clinic: req.clinicId }, { $set: { cashDeposit: deposit._id } }, { session });
      }
      if (pagos.length) {
        await Payment.updateMany({ _id: { $in: pagos }, clinic: req.clinicId }, { $set: { cashDeposit: deposit._id } }, { session });
      }
      return deposit._id;
    });

    const deposit = await CashDeposit.findById(depositId).populate('bankAccount', 'name bank');
    return res.status(201).json(deposit);
  } catch (e) {
    if (e.code === 11000 && idempotencyKey) {
      const existing = await CashDeposit.findOne({ clinic: req.clinicId, idempotencyKey });
      if (existing) return res.status(200).json({ ...existing.toObject(), idempotentReplay: true });
    }
    return res.status(e.status || 400).json({ message: e.message });
  }
};

/**
 * Anula un depósito: reversa su asiento, anula el movimiento bancario (descontando el saldo del
 * banco) y libera los documentos, que vuelven a quedar pendientes de depositar.
 */
exports.void = async (req, res) => {
  try {
    const result = await runInTransaction(async (session) => {
      const d = await CashDeposit.findOne({ _id: req.params.id, clinic: req.clinicId }).session(session);
      if (!d) throw Object.assign(new Error('Depósito no encontrado'), { status: 404 });
      if (d.status === 'ANULADO') throw Object.assign(new Error('Ya está anulado'), { status: 400 });

      const reversalDate = req.body?.date ? new Date(req.body.date) : new Date();
      await assertPeriodOpen(req.clinicId, reversalDate, { session });

      if (d.bankTransaction) {
        const tx = await BankTransaction.findById(d.bankTransaction).session(session);
        if (tx && tx.reconciled) {
          throw Object.assign(new Error(
            'El depósito ya está conciliado con el banco: reabre la conciliación antes de anularlo.'
          ), { status: 400 });
        }
        if (tx && !tx.voided) {
          tx.voided = true;
          tx.voidedAt = reversalDate;
          tx.voidedBy = req.user._id;
          tx.voidReason = req.body?.reason || 'Anulación de depósito';
          await tx.save({ session });
          await BankAccount.updateOne(
            { _id: tx.bankAccount },
            { $inc: { bookBalance: -(Number(tx.amount || 0) * Number(tx.direction || 0)) } },
            { session }
          );
        }
      }
      if (d.journalEntry) {
        await reverseEntry({
          clinicId: req.clinicId,
          entryId: d.journalEntry,
          userId: req.user._id,
          reason: `Anulación depósito ${d.number}`,
          date: reversalDate,
          session,
        });
      }

      const ventas = d.items.filter((i) => i.docModel === 'Sale').map((i) => i.docRef);
      const pagos = d.items.filter((i) => i.docModel === 'Payment').map((i) => i.docRef);
      if (ventas.length) {
        await Sale.updateMany({ _id: { $in: ventas }, clinic: req.clinicId }, { $set: { cashDeposit: null } }, { session });
      }
      if (pagos.length) {
        await Payment.updateMany({ _id: { $in: pagos }, clinic: req.clinicId }, { $set: { cashDeposit: null } }, { session });
      }

      d.status = 'ANULADO';
      d.voidReason = req.body?.reason || '';
      await d.save({ session });
      return { message: 'Depósito anulado' };
    });
    res.json(result);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};
