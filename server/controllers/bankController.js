const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const Reconciliation = require('../models/Reconciliation');
const Sale = require('../models/Sale');
const ChartOfAccount = require('../models/ChartOfAccount');
const { createEntry, findAccount } = require('../utils/accounting');

// ---------- Cuentas bancarias ----------
exports.listAccounts = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.active !== undefined) filter.active = req.query.active === 'true';
  const accs = await BankAccount.find(filter).populate('chartAccount', 'code name').sort({ name: 1 });
  res.json(accs);
};

exports.createAccount = async (req, res) => {
  try {
    const data = { ...req.body, clinic: req.clinicId };
    const acc = await BankAccount.create(data);
    res.status(201).json(acc);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateAccount = async (req, res) => {
  try {
    const acc = await BankAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!acc) return res.status(404).json({ message: 'No encontrada' });
    Object.assign(acc, req.body);
    await acc.save();
    res.json(acc);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.deleteAccount = async (req, res) => {
  const acc = await BankAccount.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!acc) return res.status(404).json({ message: 'No encontrada' });
  const has = await BankTransaction.countDocuments({ bankAccount: acc._id, voided: false });
  if (has) return res.status(400).json({ message: 'Tiene movimientos, no se puede eliminar' });
  await acc.deleteOne();
  res.json({ message: 'Eliminada' });
};

// ---------- Saldos ----------
exports.balances = async (req, res) => {
  try {
    const accounts = await BankAccount.find({ clinic: req.clinicId, active: true }).populate('chartAccount', 'code name');
    const out = [];
    for (const a of accounts) {
      const agg = await BankTransaction.aggregate([
        { $match: { clinic: a.clinic, bankAccount: a._id, voided: false } },
        { $group: { _id: null, total: { $sum: { $multiply: ['$amount', '$direction'] } } } },
      ]);
      const bookBalance = (a.initialBalance || 0) + (agg[0]?.total || 0);
      out.push({ _id: a._id, name: a.name, bank: a.bank, accountNumber: a.accountNumber,
                 chartAccount: a.chartAccount, bookBalance });
    }
    res.json(out);
  } catch (e) { res.status(500).json({ message: e.message }); }
};

// ---------- Helper: genera asiento contable de banco ----------
async function postBankJournal({ clinicId, userId, date, description, bank, counterAccountCode, amount, direction, source = 'BANCO' }) {
  const bankAcc = await ChartOfAccount.findById(bank.chartAccount);
  const counter = await findAccount(clinicId, { code: counterAccountCode });
  const lines = direction > 0
    ? [
        { account: bankAcc._id, debit: amount, credit: 0, description },
        { account: counter._id, debit: 0, credit: amount, description },
      ]
    : [
        { account: counter._id, debit: amount, credit: 0, description },
        { account: bankAcc._id, debit: 0, credit: amount, description },
      ];
  return createEntry({ clinicId, date, description, source, lines, userId });
}

// ---------- Movimientos genéricos ----------
exports.createMovement = async (req, res) => {
  try {
    const { bankAccount, type, amount, date, description, reference,
            counterAccountCode, checkNumber, counterpartAccount } = req.body;
    if (!bankAccount || !type || !amount) return res.status(400).json({ message: 'bankAccount, type y amount requeridos' });
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta bancaria no encontrada' });

    const inflow = ['DEPOSITO', 'TRANSFERENCIA_IN', 'INTERES', 'COBRO'].includes(type);
    const direction = inflow ? 1 : -1;
    const txDate = date ? new Date(date) : new Date();

    // Contracuenta por defecto según tipo
    const defaultCounter = {
      DEPOSITO: '1.1.01.01',        // contra Caja general
      RETIRO: '1.1.01.01',
      CAJA_CHICA: '1.1.01.02',
      ANTICIPO: '1.1.02.03',
      COMISION: '6.1.16',
      INTERES: '4.2.01',
      AJUSTE: '3.3.01',
      CHEQUE_EMITIDO: '2.1.01.01',
    }[type] || counterAccountCode;

    let counterpartTx = null;
    let entry = null;
    if (type === 'TRANSFERENCIA_OUT' || type === 'TRANSFERENCIA_IN') {
      if (!counterpartAccount) return res.status(400).json({ message: 'counterpartAccount requerido para transferencia' });
      const other = await BankAccount.findOne({ _id: counterpartAccount, clinic: req.clinicId });
      if (!other) return res.status(404).json({ message: 'Cuenta contraparte no encontrada' });
      // Crea asiento solo una vez: débito banco destino, crédito banco origen
      const out = direction < 0 ? bank : other;
      const inn = direction > 0 ? bank : other;
      entry = await createEntry({
        clinicId: req.clinicId, date: txDate, description: description || 'Transferencia bancaria',
        source: 'BANCO', userId: req.user._id,
        lines: [
          { account: inn.chartAccount, debit: amount, credit: 0, description },
          { account: out.chartAccount, debit: 0, credit: amount, description },
        ],
      });
      counterpartTx = await BankTransaction.create({
        clinic: req.clinicId, bankAccount: other._id, date: txDate,
        type: direction > 0 ? 'TRANSFERENCIA_OUT' : 'TRANSFERENCIA_IN',
        amount, direction: -direction, description, reference,
        counterpartAccount: bank._id, journalEntry: entry._id, createdBy: req.user._id,
      });
    } else {
      entry = await postBankJournal({
        clinicId: req.clinicId, userId: req.user._id, date: txDate,
        description: description || type, bank,
        counterAccountCode: counterAccountCode || defaultCounter,
        amount, direction,
      });
    }

    let realCheckNumber = checkNumber;
    if (type === 'CHEQUE_EMITIDO') {
      realCheckNumber = checkNumber || String(bank.nextCheckNumber);
      bank.nextCheckNumber = (parseInt(realCheckNumber, 10) || bank.nextCheckNumber) + 1;
      await bank.save();
    }

    const tx = await BankTransaction.create({
      clinic: req.clinicId, bankAccount: bank._id, date: txDate, type,
      amount, direction, description, reference, checkNumber: realCheckNumber,
      counterpartAccount: counterpartTx ? counterpartTx.bankAccount : null,
      journalEntry: entry._id, createdBy: req.user._id,
    });
    if (counterpartTx) {
      counterpartTx.counterpartAccount = bank._id;
      await counterpartTx.save();
    }
    res.status(201).json({ transaction: tx, journalEntry: entry, counterpartTx });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

exports.listMovements = async (req, res) => {
  const { bankAccount, startDate, endDate, type, reconciled, page = 1, limit = 50 } = req.query;
  const filter = { clinic: req.clinicId };
  if (bankAccount) filter.bankAccount = bankAccount;
  if (type) filter.type = type;
  if (reconciled !== undefined) filter.reconciled = reconciled === 'true';
  if (startDate || endDate) {
    filter.date = {};
    if (startDate) filter.date.$gte = new Date(startDate);
    if (endDate) filter.date.$lte = new Date(endDate);
  }
  const total = await BankTransaction.countDocuments(filter);
  const items = await BankTransaction.find(filter)
    .populate('bankAccount', 'name bank accountNumber')
    .populate('createdBy', 'name')
    .sort({ date: -1, createdAt: -1 })
    .skip((page - 1) * limit).limit(parseInt(limit));
  res.json({ items, total, pages: Math.ceil(total / limit), currentPage: parseInt(page) });
};

exports.voidMovement = async (req, res) => {
  try {
    const tx = await BankTransaction.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!tx) return res.status(404).json({ message: 'No encontrado' });
    if (tx.voided) return res.status(400).json({ message: 'Ya anulado' });
    if (tx.reconciled) return res.status(400).json({ message: 'Conciliado, no se puede anular' });
    tx.voided = true;
    tx.voidedAt = new Date();
    tx.voidedBy = req.user._id;
    tx.voidReason = req.body?.reason || '';
    await tx.save();
    // Reversar asiento
    if (tx.journalEntry) {
      const { reverseEntry } = require('../utils/accounting');
      await reverseEntry({ clinicId: req.clinicId, entryId: tx.journalEntry, userId: req.user._id, reason: `Anulación tx ${tx._id}` });
    }
    res.json({ message: 'Anulado' });
  } catch (e) { res.status(400).json({ message: e.message }); }
};

// ---------- Convertir ventas en efectivo a depósito en cuenta bancaria ----------
exports.cashToTransfer = async (req, res) => {
  try {
    const { saleIds, bankAccount, voucher, date, description } = req.body;
    if (!Array.isArray(saleIds) || !saleIds.length) return res.status(400).json({ message: 'saleIds requerido' });
    if (!bankAccount || !voucher) return res.status(400).json({ message: 'bankAccount y voucher requeridos' });
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta bancaria no encontrada' });

    const sales = await Sale.find({ _id: { $in: saleIds }, clinic: req.clinicId, paymentMethod: 'efectivo', status: 'completada' });
    if (!sales.length) return res.status(400).json({ message: 'No hay ventas en efectivo válidas' });
    const total = sales.reduce((s, v) => s + (v.total || 0), 0);

    // Asiento: Banco (DB) / Caja general (CR)
    const entry = await postBankJournal({
      clinicId: req.clinicId, userId: req.user._id,
      date: date ? new Date(date) : new Date(),
      description: description || `Depósito ventas efectivo - papeleta ${voucher}`,
      bank, counterAccountCode: '1.1.01.01',
      amount: total, direction: 1,
    });
    const tx = await BankTransaction.create({
      clinic: req.clinicId, bankAccount: bank._id, date: date ? new Date(date) : new Date(),
      type: 'DEPOSITO', amount: total, direction: 1,
      description: description || `Depósito ventas efectivo`, reference: voucher,
      journalEntry: entry._id, createdBy: req.user._id,
    });
    // Marcar ventas como transferidas (se cambia método y se asocia)
    await Sale.updateMany(
      { _id: { $in: sales.map((s) => s._id) } },
      { $set: { paymentMethod: 'transferencia', notes: `Depositado en ${bank.name} - papeleta ${voucher}` } }
    );
    res.json({ transaction: tx, journalEntry: entry, total, salesCount: sales.length });
  } catch (e) {
    res.status(e.status || 400).json({ message: e.message });
  }
};

// ---------- Conciliación bancaria ----------
exports.startReconciliation = async (req, res) => {
  try {
    const { bankAccount, periodStart, periodEnd, statementBalance } = req.body;
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta no encontrada' });
    const txs = await BankTransaction.find({
      clinic: req.clinicId, bankAccount: bank._id, voided: false,
      date: { $gte: new Date(periodStart), $lte: new Date(periodEnd) },
    }).sort({ date: 1 });
    const items = txs.map((t) => ({ transaction: t._id, matched: t.reconciled }));
    const bookBalance = txs.reduce((s, t) => s + t.amount * t.direction, 0) + (bank.initialBalance || 0);
    const rec = await Reconciliation.create({
      clinic: req.clinicId, bankAccount: bank._id,
      periodStart: new Date(periodStart), periodEnd: new Date(periodEnd),
      statementBalance, bookBalance, difference: statementBalance - bookBalance,
      items, createdBy: req.user._id,
    });
    res.status(201).json(rec);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.updateReconciliation = async (req, res) => {
  try {
    const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rec) return res.status(404).json({ message: 'No encontrada' });
    if (rec.status === 'CONCILIADO') return res.status(400).json({ message: 'Ya cerrada' });
    if (req.body.items) rec.items = req.body.items;
    if (req.body.statementBalance !== undefined) rec.statementBalance = req.body.statementBalance;
    if (req.body.notes !== undefined) rec.notes = req.body.notes;
    rec.difference = rec.statementBalance - rec.bookBalance;
    await rec.save();
    res.json(rec);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.closeReconciliation = async (req, res) => {
  try {
    const rec = await Reconciliation.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!rec) return res.status(404).json({ message: 'No encontrada' });
    if (Math.abs(rec.difference) > 0.01) return res.status(400).json({ message: `Hay diferencia de ${rec.difference.toFixed(2)}` });
    rec.status = 'CONCILIADO';
    rec.closedAt = new Date();
    await rec.save();
    const matchedIds = rec.items.filter((i) => i.matched).map((i) => i.transaction);
    await BankTransaction.updateMany({ _id: { $in: matchedIds } }, { reconciled: true, reconciliation: rec._id });
    res.json(rec);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.listReconciliations = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.bankAccount) filter.bankAccount = req.query.bankAccount;
  const items = await Reconciliation.find(filter).populate('bankAccount', 'name bank').sort({ periodEnd: -1 });
  res.json(items);
};
