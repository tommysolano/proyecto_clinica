#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Journal = require('../models/JournalEntry');
const Purchase = require('../models/PurchaseInvoice');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const BankTransaction = require('../models/BankTransaction');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

const pairs = [
  ['0yel8q6M7t2D2xeE', 'loejAo41Pinkn8dQ'],
  ['pgenGv6qDf7Q7vaN', '0yel8q4lji2D2xeE'],
];
const identity = (row) => JSON.stringify([row?.fecha, row?.glosa, row?.detalles]);
async function fetch(api, id) {
  try { return { status: 'LIVE', row: await api.get(`/api/v2/contabilidad/asiento/${id}/`) }; }
  catch (error) { return { status: error.status || 'ERROR', message: error.message }; }
}
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  const output = [];
  for (const [oldId, newId] of pairs) {
    const [oldLive, newLive, oldArchive, newArchive, oldJournal, newJournal] = await Promise.all([
      fetch(api, oldId), fetch(api, newId),
      Record.findOne({ clinic: clinic._id, entity: 'journal_entry', externalId: oldId }).lean(),
      Record.findOne({ clinic: clinic._id, entity: 'journal_entry', externalId: newId }).lean(),
      Journal.findOne({ clinic: clinic._id, number: `CTF-${oldId}` }).lean(),
      Journal.findOne({ clinic: clinic._id, number: `CTF-${newId}` }).lean(),
    ]);
    const oldPayload = oldArchive && decodeCompressedJson(oldArchive.payloadCompressed);
    const entryId = (newJournal || oldJournal)?._id;
    const [purchases, sales, payments, bankMovements] = entryId ? await Promise.all([
      Purchase.find({ clinic: clinic._id, journalEntry: entryId }).select('_id serie total sourceRef').lean(),
      Sale.find({ clinic: clinic._id, $or: [{ journalEntry: entryId }, { costJournalEntry: entryId }] }).select('_id saleNumber total').lean(),
      Payment.find({ clinic: clinic._id, journalEntry: entryId }).select('_id amount sourceRef').lean(),
      BankTransaction.find({ clinic: clinic._id, journalEntry: entryId }).select('_id amount').lean(),
    ]) : [[], [], [], []];
    output.push({ oldId, newId, oldLiveStatus: oldLive.status, newLiveStatus: newLive.status,
      archivedOld: !!oldArchive, archivedNew: !!newArchive,
      localOld: !!oldJournal, localNew: !!newJournal,
      oldArchivedStatus: oldArchive?.projection?.status || null,
      newSourceLinked: !!newJournal && String(newJournal.sourceRef) === String(newArchive?._id),
      sameArchiveAndNew: newLive.row && oldPayload ? identity(newLive.row) === identity(oldPayload) : false,
      journalDebit: (newJournal || oldJournal)?.totalDebit,
      journalCredit: (newJournal || oldJournal)?.totalCredit,
      purchases: purchases.map((row) => ({ id: String(row._id), number: row.serie, total: row.total,
        sourceRef: String(row.sourceRef) })),
      sales: sales.map((row) => ({ id: String(row._id), number: row.saleNumber, total: row.total })),
      payments: payments.map((row) => ({ id: String(row._id), amount: row.amount })),
      bankMovements: bankMovements.map((row) => ({ id: String(row._id), amount: row.amount })) });
  }
  console.log(JSON.stringify(output, null, 2));
  if (output.some((row) => ![404, 406].includes(row.oldLiveStatus) || row.newLiveStatus !== 'LIVE'
    || !row.sameArchiveAndNew || !row.archivedOld || !row.archivedNew || row.localOld || !row.localNew
    || row.oldArchivedStatus !== 'REVIEW' || !row.newSourceLinked || row.purchases.length !== 1))
    process.exitCode = 2;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
