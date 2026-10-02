#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
require('../models/ChartOfAccount');
const Bank = require('../models/BankAccount');
const Movement = require('../models/BankTransaction');
const { journalBalances, journalBankLedger, isImportedBank } = require('../services/bankJournalLedger');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const banks = (await Bank.find({ clinic: clinic._id }).populate('chartAccount', 'code name'))
    .filter(isImportedBank);
  const balances = await journalBalances(clinic._id, banks.map((row) => row.chartAccount._id),
    '2026-09-30');
  const report = [];
  for (const bank of banks) {
    const result = await journalBankLedger(bank, {
      startDate: '2026-09-01', endDate: '2026-09-30' });
    const operationalRows = await Movement.countDocuments({ clinic: clinic._id,
      bankAccount: bank._id, voided: false, date: {
        $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } });
    report.push({ code: bank.chartAccount.code, journalRows: result.count,
      operationalRows, opening: result.opening, inflow: result.totalIn,
      outflow: result.totalOut, closing: result.closing,
      fromBalancesEndpoint: balances.get(String(bank.chartAccount._id)) || 0,
      equal: result.closing === (balances.get(String(bank.chartAccount._id)) || 0) });
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.some((row) => !row.equal)) process.exitCode = 2;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
