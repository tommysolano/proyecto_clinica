#!/usr/bin/env node
'use strict';

// Reconciles the September GUI bank export with its source documents and the
// posted journal. Does not create or change journal lines.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Account = require('../models/ChartOfAccount');
const Bank = require('../models/BankAccount');
const Journal = require('../models/JournalEntry');
const Payment = require('../models/Payment');
const Sale = require('../models/Sale');
const Movement = require('../models/BankTransaction');
const { readRows, money } = require('./auditContificoSeptemberBankExport');

const bankCodeByName = new Map([
  ['Banco Pichincha Cta Cte', '1.1.1.3'],
  ['Banco Internacional', '1.1.1.4'],
  ['Banco PAcifico', '1.1.1.5'],
]);
const dateKey = (value) => {
  const found = String(value || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!found) throw new Error(`Fecha invalida: ${value}`);
  return `${found[3]}-${found[2]}-${found[1]}`;
};
const cents = (value) => Math.round(Number(value || 0) * 100);
const sourceKey = (date, code, voucher, amount) =>
  [date, code, String(voucher || '').trim(), cents(amount)].join('|');
const journalKey = (date, code, side, amount) =>
  [date, code, side, cents(amount)].join('|');
const iso = (value) => new Date(value).toISOString().slice(0, 10);

async function main() {
  const file = process.argv.find((arg) => arg.endsWith('.txt') || arg.endsWith('.tsv'));
  const commit = process.argv.includes('--commit');
  if (!file) throw new Error('Uso: node scripts/syncContificoSeptemberBankGui.js <exporte.txt> [--commit]');
  const gui = readRows(file);
  if (gui.length !== 485) throw new Error(`Se esperaban 485 filas de septiembre; hay ${gui.length}`);
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clinica Central ausente');
  const range = { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') };
  const [accounts, banks, payments, sales, movements] = await Promise.all([
    Account.find({ clinic: clinic._id, code: { $in: [...bankCodeByName.values()] } }).select('_id code').lean(),
    Bank.find({ clinic: clinic._id }).select('_id chartAccount').lean(),
    Payment.find({ clinic: clinic._id, status: 'REGISTRADO', date: range }).lean(),
    Sale.find({ clinic: clinic._id, status: 'completada', createdAt: range })
      .select('_id createdAt payments clientName costCenter journalEntry').lean(),
    Movement.find({ clinic: clinic._id, voided: false, date: range }).lean(),
  ]);
  const codeByAccount = new Map(accounts.map((row) => [String(row._id), row.code]));
  const bankByCode = new Map(banks.map((row) => [codeByAccount.get(String(row.chartAccount)), row]));
  const codeByBank = new Map([...bankByCode].map(([code, row]) => [String(row._id), code]));
  if ([...bankCodeByName.values()].some((code) => !bankByCode.has(code))) throw new Error('Falta cuenta bancaria vinculada al plan');
  const paymentByKey = new Map(), movementByKey = new Map(), saleByKey = new Map();
  const add = (map, key, item) => { const group = map.get(key) || []; group.push(item); map.set(key, group); };
  for (const payment of payments) {
    if (!payment.bankAccount) continue;
    add(paymentByKey, sourceKey(iso(payment.date), codeByBank.get(String(payment.bankAccount)),
      payment.reference, payment.total), payment);
  }
  for (const movement of movements) {
    add(movementByKey, sourceKey(iso(movement.date), codeByBank.get(String(movement.bankAccount)),
      movement.reference, movement.amount), movement);
  }
  for (const sale of sales) for (const item of sale.payments || []) {
    if (item.method !== 'transferencia' || !item.reference) continue;
    add(saleByKey, sourceKey(iso(item.date || sale.createdAt), '*', item.reference,
      item.amount), { sale, item });
  }
  const selected = [], rejected = [];
  const used = new Set();
  for (const row of gui) {
    const date = dateKey(row.Fecha), code = bankCodeByName.get(row['Cuenta Bancaria']);
    const amount = money(row.Valor), voucher = row['Numero de comprobante'];
    if (!date.startsWith('2026-09-') || !code || !voucher || !(amount > 0) || row.Anulado !== 'NO') {
      rejected.push({ voucher, reason: 'Campos de origen invalidos' }); continue;
    }
    const fullKey = sourceKey(date, code, voucher, amount);
    if (used.has(fullKey)) { rejected.push({ voucher, reason: 'Clave GUI duplicada' }); continue; }
    used.add(fullKey);
    const direct = movementByKey.get(fullKey) || [];
    const payment = paymentByKey.get(fullKey) || [];
    const sale = saleByKey.get(sourceKey(date, '*', voucher, amount)) || [];
    if (direct.length > 1 || payment.length > 1 || sale.length > 1 ||
        (direct.length && payment.length)) {
      rejected.push({ voucher, reason: 'Origen ambiguo', direct: direct.length,
        payment: payment.length, sale: sale.length }); continue;
    }
    if (!(direct.length || payment.length || sale.length)) {
      rejected.push({ voucher, reason: 'Documento fuente ausente' }); continue;
    }
    const kind = direct.length ? 'BankTransaction' : payment.length ? 'Payment' : 'Sale';
    const source = direct[0] || payment[0] || sale[0];
    const direction = kind === 'BankTransaction' ? source.direction :
      kind === 'Payment' ? (source.type === 'COBRO' ? 1 : -1) : 1;
    selected.push({ row, date, code, amount, voucher, kind, source, direction,
      bank: bankByCode.get(code), fullKey });
  }
  if (rejected.length || selected.length !== 485) throw new Error(JSON.stringify({ rejected: rejected.slice(0, 20), selected: selected.length }));

  const journals = await Journal.find({ clinic: clinic._id, status: 'CONTABILIZADO', date: range,
    'lines.account': { $in: accounts.map((row) => row._id) } })
    .select('_id number date description lines').lean();
  const ledger = new Map();
  for (const journal of journals) for (const line of journal.lines || []) {
    const code = codeByAccount.get(String(line.account));
    if (!code) continue;
    const side = Number(line.debit || 0) > 0 ? 'D' : 'H';
    const amount = Number(line.debit || 0) || Number(line.credit || 0);
    if (!amount) continue;
    add(ledger, journalKey(iso(journal.date), code, side, amount), journal);
  }
  const usage = new Map(), ledgerFailures = [];
  for (const item of selected) {
    const side = item.direction > 0 ? 'D' : 'H';
    const possibleDates = [item.date];
    if (item.row.Tipo === 'Cheque' && item.row['Fecha de Cheque'])
      possibleDates.push(dateKey(item.row['Fecha de Cheque']));
    const match = possibleDates.map((date) => journalKey(date, item.code, side, item.amount))
      .find((key) => (usage.get(key) || 0) < (ledger.get(key)?.length || 0));
    if (!match) ledgerFailures.push({ voucher: item.voucher, date: item.date,
      code: item.code, amount: item.amount, side });
    else { usage.set(match, (usage.get(match) || 0) + 1); item.ledgerKey = match; }
  }
  if (ledgerFailures.length) throw new Error(JSON.stringify({ ledgerFailures: ledgerFailures.slice(0, 20) }));
  const existing = selected.filter((item) => item.kind === 'BankTransaction');
  const toCreate = selected.filter((item) => item.kind !== 'BankTransaction');
  if (existing.length !== 18 || toCreate.length !== 467 ||
      toCreate.filter((item) => item.kind === 'Payment').length !== 21 ||
      toCreate.filter((item) => item.kind === 'Sale').length !== 446)
    throw new Error('Cobertura de fuentes distinta a la auditoria: detener lote');
  const alreadyProjected = await Movement.find({ clinic: clinic._id, voided: false,
    sourceModel: { $in: ['Payment', 'Sale'] }, sourceRef: {
      $in: toCreate.map((item) => item.kind === 'Payment' ? item.source._id : item.source.sale._id) } })
    .select('sourceModel sourceRef reference date amount bankAccount').lean();
  if (alreadyProjected.length) throw new Error(`Ya existen ${alreadyProjected.length} movimientos derivados; revisar antes de repetir`);
  const unresolvedJournalLinks = toCreate.filter((item) => {
    const sourceJournalId = item.kind === 'Payment' ? item.source.journalEntry : item.source.sale.journalEntry;
    if (!sourceJournalId) return false;
    return !(ledger.get(item.ledgerKey) || []).some((journal) => String(journal._id) === String(sourceJournalId));
  });
  if (unresolvedJournalLinks.length) throw new Error(JSON.stringify({ badJournalLinks: unresolvedJournalLinks.map((item) => item.voucher) }));
  const summary = { mode: commit ? 'COMMIT' : 'DRY_RUN', guiRows: gui.length,
    amountUnsigned: +selected.reduce((sum, item) => sum + item.amount, 0).toFixed(2),
    direct: existing.length, derivedPayments: 21, derivedSales: 446,
    journalMatchedByDateAccountAmountSide: selected.length,
    journalCheckDateFallback: selected.filter((item) => item.ledgerKey.split('|')[0] !== item.date).length,
    journalIndividualAmbiguous: selected.filter((item) => (ledger.get(item.ledgerKey) || []).length > 1).length,
    newJournalEntries: 0, examples: toCreate.slice(0, 4).map((item) => ({
      voucher: item.voucher, kind: item.kind, date: item.date, bank: item.code,
      amount: item.amount, direction: item.direction })) };
  if (!commit) { console.log(JSON.stringify(summary, null, 2)); return; }

  const folder = path.join(__dirname, '..', 'storage', 'contifico-batches');
  fs.mkdirSync(folder, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(folder, `SeptemberBankGuiBefore-${stamp}.json.gz`);
  fs.writeFileSync(backupFile, zlib.gzipSync(Buffer.from(JSON.stringify({
    bankTransactions: movements, payments: toCreate.filter((item) => item.kind === 'Payment')
      .map((item) => item.source), banks,
  }))));
  const newDocs = toCreate.map((item) => {
    const source = item.kind === 'Payment' ? item.source : item.source.sale;
    const linkedJournal = source.journalEntry && (ledger.get(item.ledgerKey) || [])
      .find((journal) => String(journal._id) === String(source.journalEntry));
    return { _id: new mongoose.Types.ObjectId(), clinic: clinic._id,
      bankAccount: item.bank._id, date: new Date(item.date),
      type: item.kind === 'Payment' ?
        (source.type === 'COBRO' ? 'COBRO' : source.method === 'CHEQUE' ? 'CHEQUE_EMITIDO' : 'PAGO') : 'COBRO',
      amount: item.amount, direction: item.direction, description: item.row.Descripcion || '',
      reference: item.voucher, voucherNumber: item.voucher,
      checkNumber: item.row['Numero de cheque'] || null,
      partyName: item.row.Persona || source.partyName || source.clientName || '',
      costCenter: item.kind === 'Sale' ? source.costCenter || null : null,
      sourceModel: item.kind, sourceRef: source._id,
      journalEntry: linkedJournal?._id || null, voided: false,
      reconciled: false, createdAt: new Date(), updatedAt: new Date() };
  });
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await Movement.collection.insertMany(newDocs, { session, ordered: true });
      const paymentUpdates = toCreate.map((item, index) => item.kind === 'Payment' ? {
        updateOne: { filter: { _id: item.source._id, bankTransaction: null },
          update: { $set: { bankTransaction: newDocs[index]._id } } },
      } : null).filter(Boolean);
      if (paymentUpdates.length) {
        const result = await Payment.collection.bulkWrite(paymentUpdates, { session, ordered: true });
        if (result.modifiedCount !== paymentUpdates.length)
          throw new Error(`Solo se enlazaron ${result.modifiedCount}/${paymentUpdates.length} pagos`);
      }
    });
  } finally { await session.endSession(); }
  const count = await Movement.countDocuments({ clinic: clinic._id, voided: false, date: range });
  if (count !== 485) throw new Error(`El lote se confirmo pero quedaron ${count}/485 movimientos; revisar respaldo ${backupFile}`);
  const manifestFile = path.join(folder, `SeptemberBankGui-${stamp}.json`);
  fs.writeFileSync(manifestFile, JSON.stringify({ ...summary, backupFile, countAfter: count,
    records: toCreate.map((item, index) => ({ voucher: item.voucher, bankCode: item.code,
      date: item.date, amount: item.amount, direction: item.direction,
      sourceModel: item.kind, sourceRef: String(item.kind === 'Payment' ?
        item.source._id : item.source.sale._id), movementId: String(newDocs[index]._id),
      journalId: newDocs[index].journalEntry && String(newDocs[index].journalEntry),
      ledgerKey: item.ledgerKey })) }, null, 2));
  console.log(JSON.stringify({ ...summary, backupFile, manifestFile, countAfter: count }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
