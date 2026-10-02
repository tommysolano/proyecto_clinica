#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

async function main() {
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  const id = 'Pnaz77lqqIMvM6bO';
  let sourceStatus;
  try { await api.get(`/api/v2/documento/${id}/`); sourceStatus = 'LIVE'; }
  catch (error) { sourceStatus = error.status || error.message; }
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const source = await Record.findOne({ clinic: clinic._id, entity: 'document', externalId: id }).lean();
  const purchase = source && await Purchase.findOne({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: source._id }).lean();
  const refs = [];
  if (purchase) {
    const probes = {
      payments: { $or: [{ docRef: purchase._id }, { 'allocations.docRef': purchase._id }, { 'applications.docRef': purchase._id }] },
      creditdebitnotes: { refDoc: purchase._id },
      fixedassets: { purchaseInvoice: purchase._id },
      inventorymovements: { sourceModel: 'PurchaseInvoice', sourceRef: purchase._id },
      inventorylayers: { sourceModel: 'PurchaseInvoice', sourceRef: purchase._id },
      payables: { sourceModel: 'PurchaseInvoice', sourceRef: purchase._id },
      retentionvouchers: { purchaseInvoice: purchase._id },
    };
    for (const [collection, filter] of Object.entries(probes)) {
      const count = await mongoose.connection.db.collection(collection).countDocuments(filter);
      if (count) refs.push({ collection, count });
    }
  }
  const archived = source && decodeCompressedJson(source.payloadCompressed);
  console.log(JSON.stringify({ sourceStatus, sourceId: id,
    source: archived && { date: archived.fecha_emision, number: archived.documento,
      total: archived.total, balance: archived.saldo, voided: archived.anulado },
    local: purchase && { id: String(purchase._id), number: purchase.serie, total: purchase.total,
      iva: purchase.iva, balance: purchase.balance, journalEntry: purchase.journalEntry }, refs }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
