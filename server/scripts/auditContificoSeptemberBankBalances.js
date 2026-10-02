#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Bank = require('../models/BankAccount');
const Account = require('../models/ChartOfAccount');
const Journal = require('../models/JournalEntry');
const Movement = require('../models/BankTransaction');

const round = (value) => +Number(value || 0).toFixed(2);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const banks = await Bank.find({ clinic: clinic._id }).lean();
  const accounts = await Account.find({ clinic: clinic._id,
    _id: { $in: banks.map((row) => row.chartAccount) } }).select('_id code').lean();
  const codeById = new Map(accounts.map((row) => [String(row._id), row.code]));
  const sums = await Journal.aggregate([
    { $match: { clinic: clinic._id, status: 'CONTABILIZADO', date: { $lt: new Date('2026-10-01') } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: banks.map((row) => row.chartAccount) } } },
    { $group: { _id: '$lines.account', debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const glByAccount = new Map(sums.map((row) => [String(row._id), row]));
  const movements = await Movement.aggregate([
    { $match: { clinic: clinic._id, voided: false, date: { $lt: new Date('2026-10-01') },
      bankAccount: { $in: banks.map((row) => row._id) } } },
    { $group: { _id: '$bankAccount', count: { $sum: 1 },
      net: { $sum: { $multiply: ['$amount', '$direction'] } } } },
  ]);
  const operationalById = new Map(movements.map((row) => [String(row._id), row]));
  console.log(JSON.stringify(banks.map((bank) => {
    const gl = glByAccount.get(String(bank.chartAccount));
    const operational = operationalById.get(String(bank._id));
    const ledgerBalance = round(Number(gl?.debit || 0) - Number(gl?.credit || 0));
    const calculatedOperational = round(Number(bank.initialBalance || 0) + Number(operational?.net || 0));
    return { code: codeById.get(String(bank.chartAccount)), bank: bank.bank,
      initialBalance: round(bank.initialBalance), initialBalanceDate: bank.initialBalanceDate,
      bankMovementsThroughSeptember: operational?.count || 0,
      calculatedOperational, ledgerBalance, difference: round(calculatedOperational - ledgerBalance),
      currentBookBalance: round(bank.bookBalance) };
  }), null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
