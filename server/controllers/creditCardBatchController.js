const CreditCardBatch = require('../models/CreditCardBatch');
const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const { createEntry, findAccount, reverseEntry } = require('../utils/accounting');

exports.list = async (req, res) => {
  const filter = { clinic: req.clinicId };
  if (req.query.status) filter.status = req.query.status;
  const items = await CreditCardBatch.find(filter).sort({ closeDate: -1 });
  res.json(items);
};

exports.get = async (req, res) => {
  const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId });
  if (!b) return res.status(404).json({ message: 'No encontrado' });
  res.json(b);
};

exports.create = async (req, res) => {
  try {
    const count = await CreditCardBatch.countDocuments({ clinic: req.clinicId });
    const code = `LOTE-${new Date().getFullYear()}-${String(count + 1).padStart(5, '0')}`;
    const vouchers = req.body.vouchers || [];
    const grossAmount = vouchers.reduce((s, v) => s + (v.grossAmount || 0), 0);
    const commissionRate = req.body.commissionRate || 0;
    const retentionRate = req.body.retentionRate || 0;
    const commissionAmount = +(grossAmount * commissionRate / 100).toFixed(2);
    const ivaCommissionAmount = +(commissionAmount * 0.15).toFixed(2);
    const retentionAmount = +(grossAmount * retentionRate / 100).toFixed(2);
    const netAmount = +(grossAmount - commissionAmount - ivaCommissionAmount - retentionAmount).toFixed(2);
    const b = await CreditCardBatch.create({
      ...req.body, clinic: req.clinicId, code,
      grossAmount, commissionAmount, ivaCommissionAmount, retentionAmount, netAmount,
      createdBy: req.user._id,
    });
    res.status(201).json(b);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

exports.update = async (req, res) => {
  try {
    const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!b) return res.status(404).json({ message: 'No encontrado' });
    if (b.status !== 'ABIERTO') return res.status(400).json({ message: 'No editable' });
    Object.assign(b, req.body);
    const grossAmount = (b.vouchers || []).reduce((s, v) => s + (v.grossAmount || 0), 0);
    b.grossAmount = grossAmount;
    b.commissionAmount = +(grossAmount * (b.commissionRate || 0) / 100).toFixed(2);
    b.ivaCommissionAmount = +(b.commissionAmount * 0.15).toFixed(2);
    b.retentionAmount = +(grossAmount * (b.retentionRate || 0) / 100).toFixed(2);
    b.netAmount = +(grossAmount - b.commissionAmount - b.ivaCommissionAmount - b.retentionAmount).toFixed(2);
    await b.save();
    res.json(b);
  } catch (e) { res.status(400).json({ message: e.message }); }
};

/** Liquida: registra depósito en banco real, gasto comisión + IVA, retención por cobrar, y descarga "tarjetas por liquidar". */
exports.liquidate = async (req, res) => {
  try {
    const { bankAccount, liquidationDate } = req.body;
    const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!b) return res.status(404).json({ message: 'No encontrado' });
    if (b.status !== 'ABIERTO') return res.status(400).json({ message: 'No es ABIERTO' });
    const bank = await BankAccount.findOne({ _id: bankAccount, clinic: req.clinicId });
    if (!bank) return res.status(404).json({ message: 'Cuenta bancaria no encontrada' });

    const bankAcc = await findAccount(req.clinicId, { id: bank.chartAccount });
    const tarjetasXliq = await findAccount(req.clinicId, { code: '1.1.02.02' });
    const comision = await findAccount(req.clinicId, { code: '6.1.17' });
    const ivaCompras = await findAccount(req.clinicId, { taxCode: 'IVA_COMPRAS' });
    // Retención que el adquirente nos efectúa (renta) → crédito tributario, no provisión incobrables
    const retXcobrar = await findAccount(req.clinicId, { code: '1.1.03.03' });

    const lines = [];
    if (b.netAmount > 0) lines.push({ account: bankAcc._id, debit: b.netAmount, credit: 0, description: `Depósito liquidación ${b.code}` });
    if (b.commissionAmount > 0) lines.push({ account: comision._id, debit: b.commissionAmount, credit: 0, description: 'Comisión tarjeta' });
    if (b.ivaCommissionAmount > 0 && ivaCompras) lines.push({ account: ivaCompras._id, debit: b.ivaCommissionAmount, credit: 0, description: 'IVA comisión' });
    if (b.retentionAmount > 0) lines.push({ account: retXcobrar._id, debit: b.retentionAmount, credit: 0, description: 'Retención por cobrar' });
    if (b.grossAmount > 0) lines.push({ account: tarjetasXliq._id, debit: 0, credit: b.grossAmount, description: 'Cancelación tarjetas por liquidar' });

    const entry = await createEntry({
      clinicId: req.clinicId, date: liquidationDate || new Date(),
      description: `Liquidación tarjetas ${b.code}`, source: 'TARJETA',
      sourceRef: b._id, sourceModel: 'CreditCardBatch',
      lines, userId: req.user._id,
    });
    const bt = await BankTransaction.create({
      clinic: req.clinicId, bankAccount: bank._id, date: liquidationDate || new Date(),
      type: 'DEPOSITO', amount: b.netAmount, direction: 1,
      description: `Liquidación tarjetas ${b.code}`, reference: b.code,
      sourceModel: 'CreditCardBatch', sourceRef: b._id, journalEntry: entry._id,
    });
    b.status = 'LIQUIDADO';
    b.liquidationDate = liquidationDate || new Date();
    b.bankAccount = bank._id;
    b.journalEntry = entry._id;
    b.bankTransaction = bt._id;
    await b.save();
    res.json(b);
  } catch (e) { res.status(e.status || 400).json({ message: e.message }); }
};

exports.cancel = async (req, res) => {
  try {
    const b = await CreditCardBatch.findOne({ _id: req.params.id, clinic: req.clinicId });
    if (!b) return res.status(404).json({ message: 'No encontrado' });
    if (b.journalEntry) await reverseEntry({ clinicId: req.clinicId, entryId: b.journalEntry, userId: req.user._id, reason: 'Anulación lote' });
    if (b.bankTransaction) await BankTransaction.updateOne({ _id: b.bankTransaction }, { voided: true });
    b.status = 'ANULADO';
    await b.save();
    res.json(b);
  } catch (e) { res.status(400).json({ message: e.message }); }
};
