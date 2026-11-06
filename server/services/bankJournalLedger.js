'use strict';

const mongoose = require('mongoose');
const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const Reconciliation = require('../models/Reconciliation');

const round = (value) => +Number(value || 0).toFixed(2);
const isImportedBank = (bank) => /^1\.1\.1\.[345]$/.test(bank?.chartAccount?.code || '');
const nextDay = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Fecha invalida: ${value}`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date;
};

/**
 * BANCOS DE LA EMPRESA (nov-2026): una sucursal que cobra por transferencia a un banco de
 * Central registra el asiento en SU libro, con la copia (mismo código) de la cuenta contable
 * del banco. El saldo y el libro del banco suman esas copias de todas las sedes de la empresa.
 * Devuelve: ids a buscar en el mayor, sedes, y de qué cuenta original es cada copia.
 */
async function cuentasEnLaEmpresa(clinicId, accountIds) {
  const { hermanas } = require('../utils/planEmpresa');
  const sedes = (await hermanas(clinicId)).map((id) => new mongoose.Types.ObjectId(String(id)));
  const originales = await ChartOfAccount.find({ _id: { $in: accountIds } }).select('code').lean();
  const codigoA = new Map(originales.map((a) => [a.code, String(a._id)]));
  const copias = await ChartOfAccount.find({ clinic: { $in: sedes }, code: { $in: [...codigoA.keys()] } })
    .select('code').lean();
  const original = new Map([
    ...accountIds.map((id) => [String(id), String(id)]),
    ...copias.map((c) => [String(c._id), codigoA.get(c.code)]),
  ]);
  return { sedes, ids: [...original.keys()].map((id) => new mongoose.Types.ObjectId(id)), original };
}

async function journalBalances(clinicId, accountIds, through = null) {
  if (!accountIds.length) return new Map();
  const { sedes, ids, original } = await cuentasEnLaEmpresa(clinicId, accountIds);
  const match = { clinic: { $in: sedes }, status: 'CONTABILIZADO',
    'lines.account': { $in: ids } };
  if (through) match.date = { $lt: nextDay(through) };
  const values = await JournalEntry.aggregate([
    { $match: match },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: ids } } },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' },
      credit: { $sum: '$lines.credit' } } },
  ]);
  const out = new Map();
  for (const row of values) {
    const key = original.get(String(row._id)) || String(row._id);
    out.set(key, round((out.get(key) || 0) + row.debit - row.credit));
  }
  return out;
}

async function journalBankLedger(bank, { startDate = null, endDate = null } = {}) {
  const { sedes, ids } = await cuentasEnLaEmpresa(bank.clinic, [bank.chartAccount._id]);
  const accountSet = new Set(ids.map(String));
  const accountId = { $in: ids };
  const opening = startDate ? await JournalEntry.aggregate([
    { $match: { clinic: { $in: sedes }, status: 'CONTABILIZADO',
      date: { $lt: new Date(startDate) }, 'lines.account': accountId } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': accountId } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' },
      credit: { $sum: '$lines.credit' } } },
  ]).then((rows) => round((rows[0]?.debit || 0) - (rows[0]?.credit || 0))) : 0;
  const match = { clinic: { $in: sedes }, status: 'CONTABILIZADO',
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
    if (!accountSet.has(String(line.account))) continue;
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
