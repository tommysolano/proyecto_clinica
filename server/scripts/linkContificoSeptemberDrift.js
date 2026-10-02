#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const Journal = require('../models/JournalEntry');
const { decodeCompressedJson } = require('../utils/compressedJson');

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const docSource = await Record.findOne({ clinic: clinic._id, entity: 'document', externalId: 'DGe7p2PmBcA9Alan' }).lean();
  const journalSource = await Record.findOne({ clinic: clinic._id, entity: 'journal_entry', externalId: 'pgenGvyZYH7Q7vaN' }).lean();
  const purchase = await Purchase.findOne({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: docSource._id }).lean();
  const journal = await Journal.findOne({ clinic: clinic._id, number: 'CTF-pgenGvyZYH7Q7vaN' }).lean();
  const doc = decodeCompressedJson(docSource.payloadCompressed);
  const sourceEntry = decodeCompressedJson(journalSource.payloadCompressed);
  if (!purchase || !journal || Number(doc.total) !== 2.85 || Number(purchase.total) !== 2.85 ||
      Number(purchase.balance) !== 2.85 || Number(journal.totalCredit) !== 2.85 ||
      !sourceEntry.detalles.some((line) => line.cuenta_id === 'RMdR77ROsv8vEel6' && line.tipo === 'H' && Number(line.valor) === 2.85))
    throw new Error('Factura y asiento no concuerdan');
  if (commit) await Purchase.updateOne({ _id: purchase._id }, { $set: { journalEntry: journal._id } });
  console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN',
    documentId: 'DGe7p2PmBcA9Alan', journalId: 'pgenGvyZYH7Q7vaN', amount: 2.85 }));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
