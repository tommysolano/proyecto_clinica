const Payment = require('../models/Payment');
const Invoice = require('../models/Invoice');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const { createEntry, findAccount, reverseEntry } = require('../utils/accounting');

async function nextNumber(clinicId, type) {
  const prefix = type === 'COBRO' ? 'CB-' : 'PG-';
  const year = new Date().getFullYear();
  const re = new RegExp(`^${prefix}${year}-`);
  const last = await Payment.findOne({ clinic: clinicId, number: re }).sort({ createdAt: -1 }).select('number');
  let n = 1;
  if (last) {
    const m = last.number.match(/(\d+)$/);
    if (m) n = parseInt(m[1]) + 1;
  }
  return `${prefix}${year}-${String(n).padStart(6, '0')}`;
}

exports.list = async (req, res) => {
  const { type, startDate, endDate, partyRef, status, page = 1, limit = 20 } = req.query;
  const filter = { clinic: req.clinicId };
  if (type) filter.type = type;
  if (partyRef) filter.partyRef = partyRef;
  if (status) filter.status = status;
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }
  const total = await Payment.countDocuments(filter);
  const items = await Payment.find(filter)
    .populate('createdBy', 'name')
    .populate('bankAccount', 'name bank')
    .sort({ date: -1, createdAt: -1 })
    .skip((page - 1) * limit).limit(parseInt(limit));
  res.json({ items, total, pages: Math.ceil(total / limit), currentPage: parseInt(page) });
};

exports.get = async (req, res) => {
  const p = await Payment.findOne({ _id: req.params.id, clinic: req.clinicId })
    .populate('createdBy', 'name')
    .populate('bankAccount', 'name bank')
    .populate('journalEntry');
  if (!p) return res.status(404).json({ message: 'No encontrado' });
  res.json(p);
};

/**
 * Crea cobro o pago, aplica a documentos, opcional anticipo.
 */
exports.create = async (req, res) => {
  try {
    const { type, date, partyModel, partyRef, partyName, partyId,
            method, bankAccount, checkNumber, reference, applications = [],
            advanceAmount = 0, description } = req.body;
    if (!['COBRO', 'PAGO'].includes(type)) return res.status(400).json({ message: 'type inválido' });
    if (!method) return res.status(400).json({ message: 'method requerido' });
    if (!['EFECTIVO'].includes(method) && !bankAccount && method !== 'TARJETA') {
      return res.status(400).json({ message: 'bankAccount requerido para este método' });
    }
    const apps = applications.map((a) => ({ ...a, amount: Number(a.amount) }));
    const appliedAmount = apps.reduce((s, a) => s + a.amount, 0);
    const total = appliedAmount + Number(advanceAmount || 0);
    if (total <= 0) return res.status(400).json({ message: 'Total debe ser mayor a 0' });

    // Validar saldos en facturas (de venta) — solo para cobros, opcional ampliar para compras
    if (type === 'COBRO') {
      for (const a of apps) {
        if (a.docModel === 'Invoice') {
          const inv = await Invoice.findOne({ _id: a.docRef, clinic: req.clinicId });
          if (!inv) return res.status(400).json({ message: `Factura no encontrada` });
        }
      }
    }

    // Cuentas contables
    const txDate = date ? new Date(date) : new Date();
    const number = await nextNumber(req.clinicId, type);

    let bank = null;
    if (bankAccount) bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });

    // Construcción del asiento
    const lines = [];
    if (type === 'COBRO') {
      // DB Banco/Caja por método  /  CR Clientes (1.1.02.01) o Anticipos clientes (2.1.01.03)
      if (method === 'EFECTIVO') {
        const caja = await findAccount(req.clinicId, { code: '1.1.01.01' });
        lines.push({ account: caja._id, debit: total, credit: 0, description: 'Cobro en efectivo' });
      } else if (method === 'TARJETA') {
        const tarj = await findAccount(req.clinicId, { code: '1.1.02.02' });
        lines.push({ account: tarj._id, debit: total, credit: 0, description: 'Cobro tarjeta - por liquidar' });
      } else {
        if (!bank) throw Object.assign(new Error('Cuenta bancaria requerida'), { status: 400 });
        lines.push({ account: bank.chartAccount, debit: total, credit: 0, description: `Cobro ${method}` });
      }
      if (appliedAmount > 0) {
        const clientes = await findAccount(req.clinicId, { code: '1.1.02.01' });
        lines.push({ account: clientes._id, debit: 0, credit: appliedAmount, description: 'Aplicación a factura' });
      }
      if (advanceAmount > 0) {
        const anticipo = await findAccount(req.clinicId, { code: '2.1.01.03' });
        lines.push({ account: anticipo._id, debit: 0, credit: advanceAmount, description: 'Anticipo cliente' });
      }
    } else {
      // PAGO: DB Proveedores (2.1.01.01) o Anticipo proveedor (1.1.02.03) / CR Banco o Caja
      if (appliedAmount > 0) {
        const prov = await findAccount(req.clinicId, { code: '2.1.01.01' });
        lines.push({ account: prov._id, debit: appliedAmount, credit: 0, description: 'Pago a proveedor' });
      }
      if (advanceAmount > 0) {
        const ant = await findAccount(req.clinicId, { code: '1.1.02.03' });
        lines.push({ account: ant._id, debit: advanceAmount, credit: 0, description: 'Anticipo a proveedor' });
      }
      if (method === 'EFECTIVO') {
        const caja = await findAccount(req.clinicId, { code: '1.1.01.01' });
        lines.push({ account: caja._id, debit: 0, credit: total, description: 'Pago en efectivo' });
      } else {
        if (!bank) throw Object.assign(new Error('Cuenta bancaria requerida'), { status: 400 });
        lines.push({ account: bank.chartAccount, debit: 0, credit: total, description: `Pago ${method}` });
      }
    }

    const entry = await createEntry({
      clinicId: req.clinicId, date: txDate,
      description: description || `${type} ${number}`,
      source: type === 'COBRO' ? 'COBRO' : 'PAGO',
      lines, userId: req.user._id,
    });

    // Banco transaction si aplica
    let bankTx = null;
    if (bank) {
      let txType = type === 'COBRO' ? 'COBRO' : 'PAGO';
      if (method === 'CHEQUE' && type === 'PAGO') {
        txType = 'CHEQUE_EMITIDO';
        if (!checkNumber) {
          bank.nextCheckNumber++;
          await bank.save();
        }
      }
      bankTx = await BankTransaction.create({
        clinic: req.clinicId, bankAccount: bank._id, date: txDate, type: txType,
        amount: total, direction: type === 'COBRO' ? 1 : -1,
        description: description || `${type} ${number}`, reference,
        checkNumber, journalEntry: entry._id, sourceModel: 'Payment', createdBy: req.user._id,
      });
    }

    const payment = await Payment.create({
      clinic: req.clinicId, type, number, date: txDate,
      partyModel: partyModel || (type === 'COBRO' ? 'Patient' : 'Supplier'),
      partyRef, partyName, partyId,
      method, bankAccount: bank?._id || null, checkNumber, reference,
      total, applications: apps, appliedAmount, advanceAmount,
      description, journalEntry: entry._id, bankTransaction: bankTx?._id || null,
      createdBy: req.user._id,
    });
    if (bankTx) { bankTx.sourceRef = payment._id; await bankTx.save(); }

    res.status(201).json(payment);
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.void = async (req, res) => {
  try {
    const p = await Payment.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!p) return res.status(404).json({ message: 'No encontrado' });
    if (p.status === 'ANULADO') return res.status(400).json({ message: 'Ya anulado' });
    if (p.journalEntry) await reverseEntry({ clinicId: req.clinicId, entryId: p.journalEntry, userId: req.user._id, reason: 'Anulación de cobro/pago' });
    if (p.bankTransaction) {
      const tx = await BankTransaction.findById(p.bankTransaction);
      if (tx && !tx.voided) {
        tx.voided = true; tx.voidedAt = new Date(); tx.voidedBy = req.user._id;
        tx.voidReason = 'Anulación de pago';
        await tx.save();
      }
    }
    p.status = 'ANULADO';
    await p.save();
    res.json({ message: 'Anulado' });
  } catch (e) { res.status(400).json({ message: e.message }); }
};
