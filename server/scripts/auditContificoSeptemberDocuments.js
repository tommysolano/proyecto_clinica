#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Sale = require('../models/Sale');
const Purchase = require('../models/PurchaseInvoice');
const Note = require('../models/CreditDebitNote');
const { decodeCompressedJson } = require('../utils/compressedJson');

const round = (value) => +Number(value || 0).toFixed(2);
const kind = (row) => `${String(row.tipo_registro || '').toUpperCase()}/${String(row.tipo_documento || '').toUpperCase()}`;
const iso = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [records, sales, purchases, notes] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'document',
      'search.date': { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
      .select('_id externalId payloadCompressed projection').lean(),
    Sale.find({ clinic: clinic._id, idempotencyKey: /^contifico:/ })
      .select('idempotencyKey saleNumber total taxAmount status createdAt journalEntry costJournalEntry invoice').lean(),
    Purchase.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' })
      .select('sourceRef serie total iva balance status journalEntry').lean(),
    Note.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' })
      .select('sourceRef serie total iva estado journalEntry').lean(),
  ]);
  const saleById = new Map(sales.map((row) => [row.idempotencyKey.slice('contifico:'.length), row]));
  const purchaseByRef = new Map(purchases.map((row) => [String(row.sourceRef), row]));
  const noteByRef = new Map(notes.map((row) => [String(row.sourceRef), row]));
  const groups = new Map(), differences = [];
  for (const record of records) {
    const source = decodeCompressedJson(record.payloadCompressed);
    const type = kind(source);
    if (!groups.has(type)) groups.set(type, { type, archived: 0, local: 0,
      sourceTotal: 0, localTotal: 0, missing: 0, fieldDifferences: 0,
      withoutJournalLink: 0, review: 0 });
    const g = groups.get(type);
    g.archived += 1; g.sourceTotal += Number(source.total || 0);
    if (record.projection?.status === 'REVIEW') g.review += 1;
    const local = ['CLI/FAC', 'CLI/NVE'].includes(type) ? saleById.get(record.externalId) :
      ['PRO/FAC', 'PRO/NVE', 'PRO/LQC', 'PRO/DNA', 'PRO/DAC', 'PRO/NCT'].includes(type) ?
        purchaseByRef.get(String(record._id)) : noteByRef.get(String(record._id));
    if (!local) { g.missing += 1;
      if (differences.length < 40) differences.push({ id: record.externalId, type, reason: 'MISSING',
        total: round(source.total), projection: record.projection?.status });
      continue; }
    g.local += 1; g.localTotal += Number(local.total || 0);
    if (!local.journalEntry) g.withoutJournalLink += 1;
    const number = local.saleNumber || local.serie;
    const iva = local.taxAmount ?? local.iva;
    const mismatch = number !== String(source.documento || '') ||
      round(local.total) !== round(source.total) || round(iva) !== round(source.iva);
    if (mismatch) { g.fieldDifferences += 1;
      if (differences.length < 40) differences.push({ id: record.externalId, type, reason: 'FIELDS',
        source: { number: source.documento, total: round(source.total), iva: round(source.iva) },
        local: { number, total: round(local.total), iva: round(iva) } }); }
  }
  const summary = [...groups.values()].sort((a, b) => a.type.localeCompare(b.type))
    .map((g) => ({ ...g, sourceTotal: round(g.sourceTotal), localTotal: round(g.localTotal) }));
  console.log(JSON.stringify({ archivedDocuments: records.length, groups: summary, differenceSamples: differences }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
