#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Journal = require('../models/JournalEntry');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { entryDifference } = require('./auditContificoLedger');
const { ledgerMaps } = require('../services/contificoFinancialSync');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const from = new Date('2026-01-01T00:00:00Z'), through = new Date('2027-01-01T00:00:00Z');
  const maps = await ledgerMaps(clinic._id);
  const report = { period: '2026', source: 0, localPosted: 0,
    missing: [], dateDifferences: [], lineDifferences: [], extraLocal: [] };
  const cursor = Record.find({ clinic: clinic._id, entity: 'journal_entry',
    'search.date': { $gte: from, $lt: through } }).select('_id externalId payloadCompressed projection').lean().cursor();
  let batch = [];
  async function compare() {
    if (!batch.length) return;
    const journals = await Journal.find({ clinic: clinic._id, sourceRef: { $in: batch.map((record) => record._id) },
      status: 'CONTABILIZADO' }).lean();
    const byRef = new Map(journals.map((journal) => [String(journal.sourceRef), journal]));
    for (const record of batch) {
      if (record.projection?.status === 'RETIRED_SOURCE_ABSENT' ||
        (record.projection?.status === 'REVIEW' && (record.projection.warnings || []).some((warning) =>
          warning.startsWith('Reemplazado en Contífico por ') ||
          warning.startsWith('Ausente de la instantánea Contífico ')))) continue;
      report.source += 1;
      const local = byRef.get(String(record._id));
      if (!local) { report.missing.push(record.externalId); continue; }
      const row = decodeCompressedJson(record.payloadCompressed);
      const difference = entryDifference(row, local, maps.sourceCodes, maps.accountById,
        maps.centerCodes, maps.centerById);
      if (difference.date) report.dateDifferences.push(record.externalId);
      if (difference.lines) report.lineDifferences.push(record.externalId);
    }
    batch = [];
  }
  for await (const record of cursor) {
    batch.push(record);
    if (batch.length >= 250) await compare();
  }
  await compare();
  const posted = await Journal.find({ clinic: clinic._id, status: 'CONTABILIZADO',
    date: { $gte: from, $lt: through } }).select('number source sourceModel').lean();
  report.localPosted = posted.length;
  report.extraLocal = posted.filter((row) => row.source !== 'MIGRACION' ||
    row.sourceModel !== 'ContificoRecord' || !row.number.startsWith('CTF-'))
    .map((row) => row.number);
  report.summary = { missing: report.missing.length, dateDifferences: report.dateDifferences.length,
    lineDifferences: report.lineDifferences.length, extraLocal: report.extraLocal.length };
  for (const key of ['missing', 'dateDifferences', 'lineDifferences', 'extraLocal'])
    report[key] = report[key].slice(0, 20);
  console.log(JSON.stringify(report, null, 2));
  if (Object.values(report.summary).some(Boolean) || report.source !== report.localPosted) process.exitCode = 1;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
