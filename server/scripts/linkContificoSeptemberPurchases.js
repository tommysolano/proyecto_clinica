#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const Journal = require('../models/JournalEntry');
const { ContificoApi } = require('../services/contificoApi');
const { checksum, search } = require('./migrateContifico');
const { decodeCompressedJson } = require('../utils/compressedJson');

const manifestFile = process.argv.find((arg) => arg.startsWith('--manifest='))?.slice('--manifest='.length);
const replacementOld = 'xgep9xLKNTnPnma1';
const replacementNew = 'BXdLAxklviR5RKeJ';
const rounded = (value) => +Number(value || 0).toFixed(2);

async function main() {
  if (!manifestFile) throw new Error('Falta --manifest');
  const commit = process.argv.includes('--commit');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  if (manifest.pairs.length !== 25) throw new Error('Manifest no contiene 25 pares');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  const liveNew = await api.get(`/api/v2/contabilidad/asiento/${replacementNew}/`);
  try {
    await api.get(`/api/v2/contabilidad/asiento/${replacementOld}/`);
    throw new Error('El asiento anterior sigue visible; no se puede reemplazar');
  } catch (error) {
    if (error.status !== 406 && error.status !== 404) throw error;
  }
  const oldSource = await Record.findOne({ clinic: clinic._id, entity: 'journal_entry', externalId: replacementOld }).lean();
  if (!oldSource) throw new Error('Falta el asiento anterior archivado');
  const oldPayload = decodeCompressedJson(oldSource.payloadCompressed);
  const identity = (row) => JSON.stringify([row.fecha, row.glosa, row.detalles]);
  if (identity(liveNew) !== identity(oldPayload)) throw new Error('El asiento sustituto tiene contenido distinto');
  const oldLocal = await Journal.findOne({ clinic: clinic._id, number: `CTF-${replacementOld}` }).lean();
  if (!oldLocal || rounded(oldLocal.totalDebit) !== 838.92 || rounded(oldLocal.totalCredit) !== 838.92)
    throw new Error('Asiento local anterior distinto del comprobado');
  const existingNew = await Record.findOne({ clinic: clinic._id, entity: 'journal_entry', externalId: replacementNew }).lean();
  if (existingNew || await Journal.exists({ clinic: clinic._id, number: `CTF-${replacementNew}` }))
    throw new Error('El asiento sustituto ya existe en el sistema');
  const pairs = manifest.pairs.map((pair) => ({ ...pair, journalId: pair.journalId === replacementOld ? replacementNew : pair.journalId }));
  const docSources = await Record.find({ clinic: clinic._id, entity: 'document', externalId: { $in: pairs.map((pair) => pair.documentId) } }).lean();
  const journalSources = await Record.find({ clinic: clinic._id, entity: 'journal_entry', externalId: { $in: pairs.map((pair) => pair.journalId) } }).lean();
  const sourceById = new Map(docSources.map((row) => [row.externalId, row]));
  const journalSourceById = new Map(journalSources.map((row) => [row.externalId, row]));
  const purchases = await Purchase.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: docSources.map((row) => row._id) } }).lean();
  const purchaseByRef = new Map(purchases.map((row) => [String(row.sourceRef), row]));
  const journals = await Journal.find({ clinic: clinic._id, number: { $in: pairs.map((pair) => `CTF-${pair.journalId}`).filter((number) => number !== `CTF-${replacementNew}`) } }).lean();
  const journalByNumber = new Map(journals.map((row) => [row.number, row]));
  journalByNumber.set(`CTF-${replacementNew}`, oldLocal);
  for (const pair of pairs) {
    const source = sourceById.get(pair.documentId);
    const purchase = source && purchaseByRef.get(String(source._id));
    const journal = journalByNumber.get(`CTF-${pair.journalId}`);
    const journalSource = pair.journalId === replacementNew ? { payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(liveNew))) } : journalSourceById.get(pair.journalId);
    if (!source || !purchase || !journal || !journalSource) throw new Error(`${pair.documentId}: vínculo incompleto`);
    const doc = decodeCompressedJson(source.payloadCompressed);
    const original = decodeCompressedJson(journalSource.payloadCompressed);
    if (rounded(doc.total) !== rounded(pair.total) || rounded(doc.saldo) !== rounded(pair.balance) ||
        rounded(purchase.total) !== rounded(pair.total) || rounded(purchase.balance) !== rounded(pair.balance) ||
        rounded(journal.totalCredit) < rounded(pair.total) ||
        !original.detalles?.some((line) => line.cuenta_id === 'RMdR77ROsv8vEel6' && line.tipo === 'H' && rounded(line.valor) === rounded(pair.total)))
      throw new Error(`${pair.documentId}: importes o asiento no coinciden`);
  }
  const report = { mode: commit ? 'COMMIT' : 'DRY_RUN', documentsLinked: pairs.length,
    replacedJournal: { old: replacementOld, new: replacementNew, amount: 838.92 },
    total: rounded(pairs.reduce((sum, pair) => sum + pair.total, 0)) };
  if (commit) {
    const newSource = await Record.create({ clinic: clinic._id, entity: 'journal_entry', externalId: replacementNew,
      payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(liveNew)), { level: 9 }), payloadEncoding: 'gzip-json',
      checksum: checksum(liveNew), capturedAt: new Date(), search: search('journal_entry', liveNew),
      projection: { status: 'LINKED_EXISTING', links: [{ model: 'JournalEntry', ref: oldLocal._id, action: 'LINK' }], warnings: [] } });
    await Journal.updateOne({ _id: oldLocal._id, number: `CTF-${replacementOld}` },
      { $set: { number: `CTF-${replacementNew}`, sourceRef: newSource._id } });
    await Record.updateOne({ _id: oldSource._id }, { $set: { projection: {
      status: 'REVIEW', links: [], warnings: [`Reemplazado en Contífico por ${replacementNew}`], projectedAt: new Date(),
    } } });
    await Purchase.bulkWrite(pairs.map((pair) => ({ updateOne: {
      filter: { _id: purchaseByRef.get(String(sourceById.get(pair.documentId)._id))._id },
      update: { $set: { journalEntry: journalByNumber.get(`CTF-${pair.journalId}`)._id } },
    } })), { ordered: false });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
