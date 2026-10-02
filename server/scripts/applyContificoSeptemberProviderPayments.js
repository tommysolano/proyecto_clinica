#!/usr/bin/env node
'use strict';

// Applies only the 17 supplier payments proved by the September GUI export,
// the live API documents, and their individual balanced journal entries.
require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Payment = require('../models/Payment');
const Journal = require('../models/JournalEntry');
const Bank = require('../models/BankAccount');
const { ContificoApi } = require('../services/contificoApi');
const { checksum, search } = require('./migrateContifico');
const { SupplementalProjector } = require('./projectContificoSupplemental');

const reportFile = process.argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length);
const commit = process.argv.includes('--commit');
const round = (value) => +Number(value || 0).toFixed(2);
const missingIds = new Set(['Ejb2Rn13JUpAp1bV', 'mBdJZV752hqPqZd0', 'BXdLgX5oAuR5RKbJ', '9jaKOWAVMT202Oak']);

async function main() {
  if (!reportFile) throw new Error('Falta --report');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const rows = report.matches;
  if (report.issues?.length || rows?.length !== 17 || round(report.total) !== 5871.83 ||
    new Set(rows.map((row) => row.id)).size !== 17 ||
    rows.filter((row) => missingIds.has(row.id)).length !== 4 ||
    rows.some((row) => !row.journalId || !row.localJournalId ||
      row.applications.some((item) => !item.localPurchase))) throw new Error('Informe de conciliación incompleto');

  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const source = await Promise.all(rows.filter((row) => missingIds.has(row.id))
    .map((row) => api.get(`/api/v1/registro/transaccion/${row.id}/`)));
  const sourceById = new Map(source.map((row) => [row.id, row]));
  const archived = await Record.find({ clinic: clinic._id, entity: 'transaction',
    externalId: { $in: rows.map((row) => row.id) } }).lean();
  const archiveById = new Map(archived.map((row) => [row.externalId, row]));
  const journals = await Journal.find({ clinic: clinic._id,
    number: { $in: rows.map((row) => `CTF-${row.journalId}`) } }).lean();
  const journalById = new Map(journals.map((row) => [row.number.slice(4), row]));
  const banks = await Bank.find({ clinic: clinic._id,
    _id: { $in: rows.map((row) => row.bankId).filter(Boolean) } }).lean();
  const bankById = new Map(banks.map((row) => [String(row._id), row]));
  const payments = await Payment.find({ clinic: clinic._id,
    idempotencyKey: { $in: rows.map((row) => `contifico:transaction:${row.id}`) } }).lean();
  const paymentById = new Map(payments.map((row) => [row.idempotencyKey.split(':').at(-1), row]));
  for (const row of rows) {
    if (row.date.slice(3) !== '09/2026' || !journalById.has(row.journalId) ||
      String(journalById.get(row.journalId)._id) !== row.localJournalId)
      throw new Error(`${row.id}: asiento local distinto del auditado`);
    if (row.bankId && !bankById.has(row.bankId)) throw new Error(`${row.id}: cuenta bancaria auditada ausente`);
    if (row.cross && row.bankId) throw new Error(`${row.id}: cruce sin efectivo tiene cuenta bancaria`);
    const current = paymentById.get(row.id);
    if (current) {
      const expected = row.applications.map((item) => `${item.localPurchase}:${round(item.amount)}`).sort();
      const actual = current.applications.map((item) => `${item.docRef}:${round(item.amount)}`).sort();
      if (round(current.total) !== row.total || JSON.stringify(expected) !== JSON.stringify(actual))
        throw new Error(`${row.id}: pago local o aplicaciones cambiaron`);
    } else if (!missingIds.has(row.id)) throw new Error(`${row.id}: desapareció pago previo`);
    if (missingIds.has(row.id)) {
      const live = sourceById.get(row.id);
      if (!live || live.fecha_emision !== row.date || round(live.total) !== row.total ||
        live.numero_comprobante !== row.voucher || live.forma !== row.sourceMethod)
        throw new Error(`${row.id}: transacción fuente cambió`);
      if (archiveById.has(row.id) && archiveById.get(row.id).checksum !== checksum(live))
        throw new Error(`${row.id}: archivo fuente difiere de la API`);
    }
  }
  const summary = { mode: commit ? 'COMMIT' : 'DRY_RUN', sourceRows: 17,
    sourceTotal: report.total, existingPayments: payments.length,
    newPayments: rows.filter((row) => !paymentById.has(row.id)).length,
    existingArchives: archived.length, journalsMatched: journals.length,
    bankPayments: rows.filter((row) => row.bankId).length,
    cashPayments: rows.filter((row) => row.expectedMethod === 'EFECTIVO').length,
    advanceCrosses: rows.filter((row) => row.cross).length };
  if (commit) {
    const now = new Date();
    await Record.bulkWrite(source.map((payload) => ({ updateOne: {
      filter: { clinic: clinic._id, entity: 'transaction', externalId: payload.id },
      update: { $set: { payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }),
        payloadEncoding: 'gzip-json', checksum: checksum(payload), capturedAt: now,
        search: search('transaction', payload) },
      $setOnInsert: { clinic: clinic._id, entity: 'transaction', externalId: payload.id,
        projection: { status: 'ARCHIVED', links: [], warnings: [] } } }, upsert: true,
    } })), { ordered: false });
    const projector = new SupplementalProjector({ clinic, commit: true, cutoff: now,
      only: new Set(['transactions']), sourceIds: missingIds });
    await projector.initialize();
    await projector.transactions();
    const refreshed = await Payment.find({ clinic: clinic._id,
      idempotencyKey: { $in: rows.map((row) => `contifico:transaction:${row.id}`) } }).lean();
    const byId = new Map(refreshed.map((row) => [row.idempotencyKey.split(':').at(-1), row]));
    if (byId.size !== 17) throw new Error(`Proyección incompleta: ${byId.size}/17`);
    for (const row of rows) {
      const current = byId.get(row.id);
      const expected = row.applications.map((item) => `${item.localPurchase}:${round(item.amount)}`).sort();
      const actual = current.applications.map((item) => `${item.docRef}:${round(item.amount)}`).sort();
      if (round(current.total) !== row.total || current.method !== row.expectedMethod ||
        round(current.appliedAmount) !== row.total || round(current.advanceAmount) !== 0 ||
        JSON.stringify(expected) !== JSON.stringify(actual))
        throw new Error(`${row.id}: proyección no coincide con los documentos`);
    }
    await Payment.bulkWrite(rows.map((row) => ({ updateOne: {
      filter: { _id: byId.get(row.id)._id },
      update: { $set: { journalEntry: journalById.get(row.journalId)._id,
        bankAccount: row.bankId ? bankById.get(row.bankId)._id : null } },
    } })), { ordered: false });
    summary.linkedPayments = rows.length;
  }
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
