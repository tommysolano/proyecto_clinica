#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Journal = require('../models/JournalEntry');
const { decodeCompressedJson } = require('../utils/compressedJson');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const source = await Record.find({ clinic: clinic._id, entity: 'document',
    'search.date': { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
    .select('externalId payloadCompressed').lean();
  const sales = source.map((record) => ({ id: record.externalId,
    row: decodeCompressedJson(record.payloadCompressed) }))
    .filter(({ row }) => row.tipo_registro === 'CLI' && ['FAC', 'NVE'].includes(row.tipo_documento));
  const journals = await Journal.find({ clinic: clinic._id, status: 'CONTABILIZADO',
    date: { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
    .select('number description sourceRef lines totalDebit').lean();
  const directKeys = [...new Set(sales.flatMap(({ row }) => Object.keys(row)))].sort();
  const sample = sales.slice(0, 8).map(({ id, row }) => ({ id, number: row.documento, total: row.total,
    possibleJournalFields: Object.fromEntries(Object.entries(row)
      .filter(([key]) => /asiento|contab|diario|journal|registro/i.test(key))) }));
  const selected = [sales[0], sales[100], sales[500], sales[1000], sales[sales.length - 1]].filter(Boolean);
  const journalMatches = selected.map(({ id, row }) => {
    const number = String(row.documento || '');
    const exact = journals.filter((journal) => number && String(journal.description || '').includes(number));
    return { id, number, candidates: exact.slice(0, 8).map((journal) => ({ number: journal.number,
      description: journal.description, debit: journal.totalDebit })), count: exact.length };
  });
  console.log(JSON.stringify({ saleCount: sales.length, journalCount: journals.length,
    sourceFields: directKeys, sample, journalMatches,
    journalSample: journals.slice(0, 20).map((row) => ({ number: row.number,
      description: row.description, debit: row.totalDebit })) }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
