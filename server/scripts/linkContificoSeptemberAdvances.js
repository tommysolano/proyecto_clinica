#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const Journal = require('../models/JournalEntry');
const { decodeCompressedJson } = require('../utils/compressedJson');

const manifestFile = process.argv.find((arg) => arg.startsWith('--manifest='))?.slice('--manifest='.length);
const round = (value) => +Number(value || 0).toFixed(2);

async function main() {
  if (!manifestFile) throw new Error('Falta --manifest');
  const commit = process.argv.includes('--commit');
  const pairs = JSON.parse(fs.readFileSync(manifestFile, 'utf8')).pairs;
  if (pairs.length !== 4) throw new Error('Se esperaban cuatro anticipos');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const sourceDocs = await Record.find({ clinic: clinic._id, entity: 'document', externalId: { $in: pairs.map((pair) => pair.documentId) } }).lean();
  const docsById = new Map(sourceDocs.map((row) => [row.externalId, row]));
  const purchases = await Purchase.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: sourceDocs.map((row) => row._id) } }).lean();
  const purchasesByRef = new Map(purchases.map((row) => [String(row.sourceRef), row]));
  const journals = await Journal.find({ clinic: clinic._id, number: { $in: pairs.map((pair) => `CTF-${pair.journalId}`) } }).lean();
  const journalByNumber = new Map(journals.map((row) => [row.number, row]));
  const sourceJournals = await Record.find({ clinic: clinic._id, entity: 'journal_entry', externalId: { $in: pairs.map((pair) => pair.journalId) } }).lean();
  const journalSourceById = new Map(sourceJournals.map((row) => [row.externalId, row]));
  const ops = [];
  for (const pair of pairs) {
    const source = docsById.get(pair.documentId);
    const purchase = source && purchasesByRef.get(String(source._id));
    const journal = journalByNumber.get(`CTF-${pair.journalId}`);
    const journalSource = journalSourceById.get(pair.journalId);
    if (!source || !purchase || !journal || !journalSource) throw new Error(`${pair.documentId}: faltan referencias`);
    const doc = decodeCompressedJson(source.payloadCompressed);
    const entry = decodeCompressedJson(journalSource.payloadCompressed);
    if (doc.tipo_documento !== 'DAC' || purchase.docType !== 'ANTICIPO_PROVEEDOR' ||
        round(purchase.total) !== round(pair.total) || round(purchase.balance) !== 0 ||
        round(journal.totalDebit) !== round(pair.total) || round(journal.totalCredit) !== round(pair.total) ||
        !entry.detalles?.some((line) => line.cuenta_id === 'O8bYRRzMhLPLMd7j' && line.tipo === 'D' && round(line.valor) === round(pair.total)) ||
        !entry.detalles?.some((line) => line.cuenta_id === 'RMdR77ROsv8vEel6' && line.tipo === 'H' && round(line.valor) === round(pair.total)))
      throw new Error(`${pair.documentId}: comprobante y asiento difieren`);
    ops.push({ updateOne: { filter: { _id: purchase._id }, update: { $set: { journalEntry: journal._id } } } });
  }
  if (commit) await Purchase.bulkWrite(ops, { ordered: false });
  console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', linked: ops.length,
    total: round(pairs.reduce((sum, pair) => sum + pair.total, 0)) }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
