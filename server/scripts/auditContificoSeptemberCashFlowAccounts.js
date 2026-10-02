#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Account = require('../models/ChartOfAccount');
const Journal = require('../models/JournalEntry');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [legacy, current] = await Promise.all([
    Account.find({ clinic: clinic._id, code: /^1\.1\.01\./ }).select('_id code allowsMovement').lean(),
    Account.find({ clinic: clinic._id, code: /^1\.1\.1\./ }).select('_id code allowsMovement').lean(),
  ]);
  const ids = current.map((row) => row._id);
  const lines = await Journal.aggregate([
    { $match: { clinic: clinic._id, status: 'CONTABILIZADO',
      date: { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } } },
    { $unwind: '$lines' }, { $match: { 'lines.account': { $in: ids } } },
    { $group: { _id: '$lines.account', count: { $sum: 1 },
      debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const byId = new Map(current.map((row) => [String(row._id), row.code]));
  console.log(JSON.stringify({ codeUsedByReport: '^1.1.01.', reportAccounts: legacy.length,
    legacyAccounts: legacy.map((row) => ({ code: row.code, allowsMovement: row.allowsMovement })),
    actualCashBankAccounts: current.length, accountsWithJournalLines: lines.length,
    septemberJournalLines: lines.reduce((sum, row) => sum + row.count, 0),
    septemberDebit: +lines.reduce((sum, row) => sum + row.debit, 0).toFixed(2),
    septemberCredit: +lines.reduce((sum, row) => sum + row.credit, 0).toFixed(2),
    accounts: lines.map((row) => ({ code: byId.get(String(row._id)), count: row.count,
      debit: +row.debit.toFixed(2), credit: +row.credit.toFixed(2) })) }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
