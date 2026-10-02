#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Bank = require('../models/BankAccount');
const Account = require('../models/ChartOfAccount');
const Payment = require('../models/Payment');
const Sale = require('../models/Sale');
const Movement = require('../models/BankTransaction');
const { readRows, money } = require('./auditContificoSeptemberBankExport');

const bankCodeByName = new Map([
  ['Banco Pichincha Cta Cte', '1.1.1.3'],
  ['Banco Internacional', '1.1.1.4'],
  ['Banco PAcifico', '1.1.1.5'],
]);
const dateKey = (date) => {
  const match = String(date).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) throw new Error(`Fecha invalida: ${date}`);
  return `${match[3]}-${match[2]}-${match[1]}`;
};
const cents = (value) => Math.round(Number(value || 0) * 100);
const key = (date, code, voucher, amount) => [date, code, String(voucher || '').trim(), cents(amount)].join('|');
const round = (value) => +Number(value || 0).toFixed(2);

async function main() {
  const gui = readRows(process.argv[2]);
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [accounts, banks, payments, movements, sales] = await Promise.all([
    Account.find({ clinic: clinic._id, code: { $in: [...bankCodeByName.values()] } }).select('_id code').lean(),
    Bank.find({ clinic: clinic._id }).select('_id chartAccount').lean(),
    Payment.find({ clinic: clinic._id, status: 'REGISTRADO', date: {
      $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
      .select('_id type date total reference number bankAccount method partyName journalEntry bankTransaction').lean(),
    Movement.find({ clinic: clinic._id, voided: false, date: {
      $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
      .select('_id date amount reference bankAccount sourceModel sourceRef journalEntry').lean(),
    Sale.find({ clinic: clinic._id, createdAt: { $gte: new Date('2026-09-01'),
      $lt: new Date('2026-10-01') } }).select('_id createdAt payments clientName journalEntry').lean(),
  ]);
  const codeByAccount = new Map(accounts.map((row) => [String(row._id), row.code]));
  const codeByBank = new Map(banks.map((row) => [String(row._id), codeByAccount.get(String(row.chartAccount))]));
  const guiByKey = new Map();
  for (const row of gui) {
    const k = key(dateKey(row.Fecha), bankCodeByName.get(row['Cuenta Bancaria']),
      row['Numero de comprobante'], money(row.Valor));
    const group = guiByKey.get(k) || [];
    group.push(row);
    guiByKey.set(k, group);
  }
  const paymentsByKey = new Map();
  for (const row of payments) {
    if (!row.bankAccount) continue;
    const k = key(row.date.toISOString().slice(0, 10), codeByBank.get(String(row.bankAccount)),
      row.reference, row.total);
    const group = paymentsByKey.get(k) || [];
    group.push(row);
    paymentsByKey.set(k, group);
  }
  const movementsByKey = new Map();
  for (const row of movements) {
    const k = key(row.date.toISOString().slice(0, 10), codeByBank.get(String(row.bankAccount)),
      row.reference, row.amount);
    const group = movementsByKey.get(k) || [];
    group.push(row);
    movementsByKey.set(k, group);
  }
  const salesByKey = new Map();
  for (const sale of sales) for (const item of sale.payments || []) {
    if (item.method === 'credito' || !item.reference) continue;
    // La importacion de Sale conserva comprobante y valor del cobro, pero su
    // desglose de origen no incluye cuenta bancaria. El banco viene del GUI.
    const k = key(new Date(item.date || sale.createdAt).toISOString().slice(0, 10),
      '*', item.reference, item.amount);
    const group = salesByKey.get(k) || [];
    group.push({ sale, item });
    salesByKey.set(k, group);
  }
  const report = { gui: gui.length, payments: payments.length, movements: movements.length,
    sales: sales.length, bankedPayments: paymentsByKey.size, bankedSaleLines: [...salesByKey.values()].reduce((n, x) => n + x.length, 0),
    overlap: { paymentOnly: 0, bankOnly: 0, saleOnly: 0, both: 0,
      neither: 0, ambiguousPaymentRows: 0, ambiguousSaleRows: 0 }, unmatched: [],
    paymentTypes: {}, paymentMethodTypes: {}, saleMethodTypes: {},
    paymentWithJournal: 0,
    paymentWithBankTransaction: 0, candidates: [] };
  for (const [k, rows] of guiByKey) {
    const paymentRows = paymentsByKey.get(k) || [];
    const movementRows = movementsByKey.get(k) || [];
    const [date, , voucher, amount] = k.split('|');
    const saleRows = salesByKey.get([date, '*', voucher, amount].join('|')) || [];
    const matched = Math.min(rows.length, paymentRows.length + movementRows.length + saleRows.length);
    if (paymentRows.length && movementRows.length) report.overlap.both += rows.length;
    else if (paymentRows.length) report.overlap.paymentOnly += Math.min(rows.length, paymentRows.length);
    else if (movementRows.length) report.overlap.bankOnly += Math.min(rows.length, movementRows.length);
    else if (saleRows.length) report.overlap.saleOnly += Math.min(rows.length, saleRows.length);
    if (paymentRows.length > 1 || rows.length > 1) report.overlap.ambiguousPaymentRows += Math.min(rows.length, paymentRows.length);
    if (saleRows.length > 1 || rows.length > 1) report.overlap.ambiguousSaleRows += Math.min(rows.length, saleRows.length);
    for (const match of saleRows) report.saleMethodTypes[match.item.method] =
      (report.saleMethodTypes[match.item.method] || 0) + 1;
    if (!matched) report.overlap.neither += rows.length;
    for (const payment of paymentRows) {
      report.paymentTypes[payment.type] = (report.paymentTypes[payment.type] || 0) + 1;
      report.paymentMethodTypes[payment.method] = (report.paymentMethodTypes[payment.method] || 0) + 1;
      if (payment.journalEntry) report.paymentWithJournal += 1;
      if (payment.bankTransaction) report.paymentWithBankTransaction += 1;
      report.candidates.push({ key: k, guiCount: rows.length, paymentCount: paymentRows.length,
        bankMovementCount: movementRows.length, payment: String(payment._id),
        type: payment.type, method: payment.method, amount: payment.total,
        journal: payment.journalEntry && String(payment.journalEntry),
        bankTransaction: payment.bankTransaction && String(payment.bankTransaction) });
    }
    if (rows.length > paymentRows.length + movementRows.length + saleRows.length) report.unmatched.push({
      key: k, guiCount: rows.length, paymentCount: paymentRows.length,
      movementCount: movementRows.length, saleCount: saleRows.length,
      name: rows[0].Persona, description: rows[0].Descripcion });
  }
  console.log(JSON.stringify({ ...report, candidates: report.candidates.slice(0, 10),
    candidatesCount: report.candidates.length, unmatched: report.unmatched.slice(0, 40),
    unmatchedCount: report.unmatched.length }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
