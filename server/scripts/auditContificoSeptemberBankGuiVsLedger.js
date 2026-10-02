#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Account = require('../models/ChartOfAccount');
const Journal = require('../models/JournalEntry');
const Bank = require('../models/BankAccount');
const Movement = require('../models/BankTransaction');
const { readRows, money } = require('./auditContificoSeptemberBankExport');

const file = process.argv[2];
const accountCodes = new Map([
  ['Banco Pichincha Cta Cte', '1.1.1.3'],
  ['Banco Internacional', '1.1.1.4'],
  ['Banco PAcifico', '1.1.1.5'],
]);
const dateKey = (date) => {
  const parts = String(date || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!parts) throw new Error(`Fecha del exporte inválida: ${date}`);
  return `${parts[3]}-${parts[2]}-${parts[1]}`;
};
const cents = (amount) => Math.round(Number(amount || 0) * 100);
const byKey = (date, code, amount) => `${date}|${code}|${cents(amount)}`;
const round = (value) => +Number(value || 0).toFixed(2);

async function main() {
  if (!file) throw new Error('Falta archivo TSV como argumento');
  const gui = readRows(file);
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [accounts, banks] = await Promise.all([
    Account.find({ clinic: clinic._id, code: { $in: [...accountCodes.values()] } }).select('_id code').lean(),
    Bank.find({ clinic: clinic._id }).select('_id chartAccount bank').lean(),
  ]);
  const codeByAccount = new Map(accounts.map((row) => [String(row._id), row.code]));
  const codeByBank = new Map(banks.map((row) => [String(row._id), codeByAccount.get(String(row.chartAccount))]));
  const from = new Date('2026-09-01'), through = new Date('2026-10-01');
  const [journals, bankTransactions] = await Promise.all([
    Journal.find({ clinic: clinic._id, status: 'CONTABILIZADO', date: { $gte: from, $lt: through },
      'lines.account': { $in: accounts.map((row) => row._id) } })
      .select('number date description lines').lean(),
    Movement.find({ clinic: clinic._id, voided: false, date: { $gte: from, $lt: through } })
      .select('date bankAccount amount reference direction sourceRef').lean(),
  ]);
  const ledgerByKey = new Map(), ledgerByBank = new Map();
  for (const journal of journals) for (const line of journal.lines || []) {
    const code = codeByAccount.get(String(line.account));
    if (!code) continue;
    const amount = Number(line.debit || 0) || Number(line.credit || 0);
    if (!amount) continue;
    const key = byKey(journal.date.toISOString().slice(0, 10), code, amount);
    const bucket = ledgerByKey.get(key) || [];
    bucket.push({ number: journal.number, description: journal.description,
      side: Number(line.debit || 0) > 0 ? 'D' : 'H', amount });
    ledgerByKey.set(key, bucket);
    const summary = ledgerByBank.get(code) || { code, lines: 0, debit: 0, credit: 0 };
    summary.lines += 1;
    summary.debit += Number(line.debit || 0);
    summary.credit += Number(line.credit || 0);
    ledgerByBank.set(code, summary);
  }
  const guiByKey = new Map(), guiByBank = new Map();
  for (const row of gui) {
    const code = accountCodes.get(row['Cuenta Bancaria']);
    if (!code) throw new Error(`Cuenta bancaria desconocida: ${row['Cuenta Bancaria']}`);
    const amount = money(row.Valor), date = dateKey(row.Fecha);
    const key = byKey(date, code, amount);
    const bucket = guiByKey.get(key) || [];
    bucket.push(row);
    guiByKey.set(key, bucket);
    const summary = guiByBank.get(code) || { code, rows: 0, unsigned: 0 };
    summary.rows += 1; summary.unsigned += amount;
    guiByBank.set(code, summary);
  }
  const unmatchedGui = [], extraLedger = [];
  let matchedByDateAccountAmount = 0, ambiguousMatchedRows = 0;
  for (const [key, rows] of guiByKey) {
    const ledger = ledgerByKey.get(key) || [];
    const matched = Math.min(rows.length, ledger.length);
    matchedByDateAccountAmount += matched;
    if (ledger.length > 1 || rows.length > 1) ambiguousMatchedRows += matched;
    unmatchedGui.push(...rows.slice(matched).map((row) => ({ date: row.Fecha, bank: row['Cuenta Bancaria'],
      voucher: row['Numero de comprobante'], checkDate: row['Fecha de Cheque'],
      checkNumber: row['Numero de cheque'], type: row.Tipo,
      amount: money(row.Valor), description: row.Descripcion })));
  }
  for (const [key, rows] of ledgerByKey) {
    const matched = Math.min(rows.length, guiByKey.get(key)?.length || 0);
    extraLedger.push(...rows.slice(matched).map((row) => ({ key, ...row })));
  }
  let matchedByCheckDate = 0;
  for (let index = unmatchedGui.length - 1; index >= 0; index -= 1) {
    const row = unmatchedGui[index];
    if (row.type !== 'Cheque' || !row.checkDate) continue;
    const alternate = byKey(dateKey(row.checkDate), accountCodes.get(row.bank), row.amount);
    const candidates = extraLedger.map((line, position) => ({ line, position }))
      .filter(({ line }) => line.key === alternate && line.side === 'H' &&
        line.description === row.description);
    if (candidates.length !== 1) continue;
    extraLedger.splice(candidates[0].position, 1);
    unmatchedGui.splice(index, 1);
    matchedByCheckDate += 1;
  }
  const bankGuiByVoucher = new Map();
  for (const row of gui) {
    const key = [dateKey(row.Fecha), accountCodes.get(row['Cuenta Bancaria']),
      row['Numero de comprobante'], cents(money(row.Valor))].join('|');
    bankGuiByVoucher.set(key, (bankGuiByVoucher.get(key) || 0) + 1);
  }
  const auxiliaryByVoucher = new Map();
  for (const row of bankTransactions) {
    const key = [row.date.toISOString().slice(0, 10), codeByBank.get(String(row.bankAccount)),
      String(row.reference || ''), cents(row.amount)].join('|');
    auxiliaryByVoucher.set(key, (auxiliaryByVoucher.get(key) || 0) + 1);
  }
  const missingAux = [...auxiliaryByVoucher].flatMap(([key, count]) =>
    Array(Math.max(0, count - (bankGuiByVoucher.get(key) || 0))).fill(key));
  const missingGui = [...bankGuiByVoucher].flatMap(([key, count]) =>
    Array(Math.max(0, count - (auxiliaryByVoucher.get(key) || 0))).fill(key));
  const report = { guiRows: gui.length, guiUnsigned: round(gui.reduce((sum, row) => sum + money(row.Valor), 0)),
    bankJournalLines: [...ledgerByKey.values()].reduce((sum, rows) => sum + rows.length, 0),
    matchedByDateAccountAmount, matchedByCheckDate, ambiguousMatchedRows,
    unmatchedGui: unmatchedGui.length, unmatchedGuiSamples: unmatchedGui.slice(0, 35),
    extraLedger: extraLedger.length, extraLedgerSamples: extraLedger.slice(0, 35),
    extraLedgerByBankSide: [...extraLedger.reduce((map, row) => {
      const [date, code] = row.key.split('|');
      const key = `${code}|${row.side}`;
      const summary = map.get(key) || { bank: code, side: row.side, count: 0, unsigned: 0,
        examples: [] };
      summary.count += 1; summary.unsigned += row.amount;
      if (summary.examples.length < 8) summary.examples.push({ date, journal: row.number,
        amount: row.amount, description: row.description });
      map.set(key, summary);
      return map;
    }, new Map()).values()].map((row) => ({ ...row, unsigned: round(row.unsigned) })),
    guiByBank: [...guiByBank.values()].map((row) => ({ ...row, unsigned: round(row.unsigned) })),
    ledgerByBank: [...ledgerByBank.values()].map((row) => ({ ...row,
      debit: round(row.debit), credit: round(row.credit) })),
    auxiliaryMovements: bankTransactions.length,
    guiNotInAuxiliary: missingGui.length, guiNotInAuxiliarySamples: missingGui.slice(0, 20),
    auxiliaryNotInGui: missingAux.length,
    auxiliaryNotInGuiSamples: missingAux.slice(0, 20),
  };
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
