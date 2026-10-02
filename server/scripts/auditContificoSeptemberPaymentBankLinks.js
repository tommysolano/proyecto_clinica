#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const BankTransaction = require('../models/BankTransaction');

async function main() {
  const report = JSON.parse(fs.readFileSync('storage/contifico-batches/SeptemberProviderPayments-2026-10-01.json'));
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const journals = new Map(report.matches.map((row) => [row.localJournalId, row]));
  const movements = await BankTransaction.find({ clinic: clinic._id,
    journalEntry: { $in: [...journals.keys()] } }).lean();
  const septemberOutflows = await BankTransaction.find({ clinic: clinic._id,
    date: { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') }, direction: -1 }).lean();
  const links = movements.map((movement) => ({ payment: journals.get(String(movement.journalEntry))?.id,
    bankMovement: String(movement._id), date: movement.date, amount: movement.amount,
    direction: movement.direction, bankAccount: String(movement.bankAccount) }));
  const candidates = report.matches.filter((row) => row.bankId).map((row) => ({ id: row.id,
    matches: septemberOutflows.filter((movement) =>
      String(movement.bankAccount) === row.bankId &&
      movement.date.toISOString().slice(0, 10) === `${row.date.slice(6)}-${row.date.slice(3, 5)}-${row.date.slice(0, 2)}` &&
      +movement.amount.toFixed(2) === row.total)
      .map((movement) => ({ id: String(movement._id), reference: movement.reference })) }));
  console.log(JSON.stringify({ payments: report.matches.length, bankMovementLinks: links.length,
    septemberOutflows: septemberOutflows.length,
    exactCandidates: candidates.filter((row) => row.matches.length).length,
    candidates: candidates.filter((row) => row.matches.length), links }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
