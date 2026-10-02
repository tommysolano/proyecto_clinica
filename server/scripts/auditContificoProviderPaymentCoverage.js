#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Payment = require('../models/Payment');

const round = (value) => +Number(value || 0).toFixed(2);
const month = (date) => date ? new Date(date).toISOString().slice(0, 7) : 'SIN_FECHA';

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [source, local] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'transaction', 'search.type': 'P' })
      .select('externalId search.date search.amount').lean(),
    Payment.find({ clinic: clinic._id, type: 'PAGO',
      idempotencyKey: /^contifico:transaction:/ })
      .select('idempotencyKey date total applications appliedAmount advanceAmount bankAccount journalEntry').lean(),
  ]);
  const localById = new Map(local.map((row) => [row.idempotencyKey.slice('contifico:transaction:'.length), row]));
  const sourceIds = new Set(source.map((row) => row.externalId));
  const byMonth = new Map();
  const group = (key) => {
    if (!byMonth.has(key)) byMonth.set(key, { month: key, archived: 0, local: 0,
      sourceTotal: 0, localTotal: 0, missingLocal: 0, localWithoutArchive: 0,
      amountDifferences: 0, dateDifferences: 0, withoutJournalLink: 0,
      withoutBankLink: 0, withoutApplication: 0 });
    return byMonth.get(key);
  };
  const samples = [];
  for (const row of source) {
    const item = group(month(row.search?.date));
    item.archived += 1; item.sourceTotal += Number(row.search?.amount || 0);
    const payment = localById.get(row.externalId);
    if (!payment) { item.missingLocal += 1; if (samples.length < 30) samples.push({ id: row.externalId,
      kind: 'MISSING_LOCAL', month: month(row.search?.date), amount: row.search?.amount }); continue; }
    if (month(payment.date) !== month(row.search?.date)) item.dateDifferences += 1;
    if (round(payment.total) !== round(row.search?.amount)) item.amountDifferences += 1;
    if (!payment.journalEntry) item.withoutJournalLink += 1;
    if (!payment.bankAccount) item.withoutBankLink += 1;
    if (!payment.applications?.length) item.withoutApplication += 1;
  }
  for (const row of local) {
    const item = group(month(row.date));
    item.local += 1; item.localTotal += Number(row.total || 0);
    const id = row.idempotencyKey.slice('contifico:transaction:'.length);
    if (!sourceIds.has(id)) { item.localWithoutArchive += 1;
      if (samples.length < 30) samples.push({ id, kind: 'LOCAL_WITHOUT_ARCHIVE' }); }
  }
  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month)).map((row) => ({
    ...row, sourceTotal: round(row.sourceTotal), localTotal: round(row.localTotal) }));
  console.log(JSON.stringify({ sourceRecords: source.length, localPayments: local.length, months, samples }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
