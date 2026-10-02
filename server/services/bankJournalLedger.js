'use strict';

const JournalEntry = require('../models/JournalEntry');
const Reconciliation = require('../models/Reconciliation');

const round = (value) => +Number(value || 0).toFixed(2);
const isImportedBank = (bank) => /^1\.1\.1\.[345]$/.test(bank?.chartAccount?.code || '');
const nextDay = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha invalida: ${value}`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
};

async function journalBalances(clinicId, accountIds, through = null) {
  if (!accountIds.length) return new Map();
  const match = { clinic: clinicId, status: 'CONTABILIZADO',
    'lines.account': { $in: accountIds } };
  if (through) match.date = { $lt: nextDay(through) };
  const values = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: accountIds } } },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' },
      credit: { $sum: '$lines.credit' } } },
  ]);
  return new Map(values.map((row) => [String(row._id), round(row.debit - row.credit)]));
}

async function journalBankLedger(bank, { startDate = null, endDate = null } = {}) {
  const accountId = bank.chartAccount._id;
  const opening = startDate ? await JournalEntry.aggregate([
    { $match: { clinic: bank.clinic, status: 'CONTABILIZADO',
      date: { $lt: new Date(startDate) }, 'lines.account': accountId } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': accountId } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' },
      credit: { $sum: '$lines.credit' } } },
  ]).then((rows) => round((rows[0]?.debit || 0) - (rows[0]?.credit || 0))) : 0;
  const match = { clinic: bank.clinic, status: 'CONTABILIZADO',
    'lines.account': accountId };
  if (startDate || endDate) {
    match.date = {};
    if (startDate) match.date.$gte = new Date(startDate);
    if (endDate) match.date.$lt = nextDay(endDate);
  }
  const journals = await JournalEntry.find(match).sort({ date: 1, number: 1 }).lean();
  // Líneas del mayor que una conciliación cerrada (importada de Contífico) ya concilió.
  const reconciledLines = new Set((await Reconciliation.find({ clinic: bank.clinic, bankAccount: bank._id,
    status: 'CONCILIADO', 'journalItems.0': { $exists: true } }).select('journalItems.lines').lean())
    .flatMap((rec) => rec.journalItems.flatMap((item) => item.lines || []))
    .map((line) => `${line.journalEntry}-${line.lineIndex}`));
  let running = opening;
  const rows = [];
  for (const journal of journals) for (const [index, line] of journal.lines.entries()) {
    if (String(line.account) !== String(accountId)) continue;
    const inflow = round(line.debit), outflow = round(line.credit);
    running = round(running + inflow - outflow);
    rows.push({ _id: `${journal._id}-${index}`, date: journal.date,
      type: 'ASIENTO', description: journal.description || line.description || '',
      reference: journal.number, voucherNumber: '', checkNumber: '',
      inflow, outflow, reconciled: reconciledLines.has(`${journal._id}-${index}`), runningBalance: running,
      journalEntry: journal._id });
  }
  return { bankAccount: { _id: bank._id, name: bank.name, bank: bank.bank,
    accountNumber: bank.accountNumber, chartAccount: bank.chartAccount },
  source: 'JOURNAL', opening, rows,
  totalIn: round(rows.reduce((sum, row) => sum + row.inflow, 0)),
  totalOut: round(rows.reduce((sum, row) => sum + row.outflow, 0)),
  closing: running, count: rows.length };
}

module.exports = { isImportedBank, journalBalances, journalBankLedger, nextDay };
