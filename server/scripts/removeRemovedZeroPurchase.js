#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

async function main() {
  const commit = process.argv.includes('--commit');
  const removedId = 'Pnaz77lqqIMvM6bO';
  const liveId = 'YWb4zQKxkCBGBgeZ';
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  try { await api.get(`/api/v2/documento/${removedId}/`); throw new Error('Documento cero todavía existe'); }
  catch (error) { if (error.status !== 400) throw error; }
  const live = await api.get(`/api/v2/documento/${liveId}/`);
  if (live.documento !== '003-001-000000712' || Number(live.total) !== 675)
    throw new Error('El documento vivo homónimo no coincide');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const source = await Record.findOne({ clinic: clinic._id, entity: 'document', externalId: removedId }).lean();
  const purchase = await Purchase.findOne({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: source._id }).lean();
  const old = decodeCompressedJson(source.payloadCompressed);
  if (!purchase || old.documento !== live.documento || Number(old.total) !== 0 || Number(old.saldo) !== 0 ||
      purchase.total !== 0 || purchase.iva !== 0 || purchase.balance !== 0 || purchase.journalEntry)
    throw new Error('Documento cero local no cumple las condiciones de retiro');
  const probes = {
    payments: { $or: [{ docRef: purchase._id }, { 'allocations.docRef': purchase._id }, { 'applications.docRef': purchase._id }] },
    creditdebitnotes: { refDoc: purchase._id }, fixedassets: { purchaseInvoice: purchase._id },
    inventorymovements: { sourceModel: 'PurchaseInvoice', sourceRef: purchase._id },
    inventorylayers: { sourceModel: 'PurchaseInvoice', sourceRef: purchase._id },
    payables: { sourceModel: 'PurchaseInvoice', sourceRef: purchase._id },
    retentionvouchers: { purchaseInvoice: purchase._id },
  };
  for (const [collection, filter] of Object.entries(probes))
    if (await mongoose.connection.db.collection(collection).countDocuments(filter))
      throw new Error(`Documento cero aún está referenciado por ${collection}`);
  const report = { mode: commit ? 'COMMIT' : 'DRY_RUN', removedId, liveId,
    number: live.documento, removedTotal: 0, liveTotal: 675 };
  if (commit) {
    const folder = path.resolve(__dirname, '..', 'storage', 'contifico-batches');
    fs.mkdirSync(folder, { recursive: true });
    const backup = path.join(folder, `removed-zero-purchase-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`);
    fs.writeFileSync(backup, [EJSON.stringify(source, { relaxed: false }),
      EJSON.stringify(purchase, { relaxed: false })].join('\n') + '\n', { flag: 'wx' });
    await Purchase.deleteOne({ _id: purchase._id, sourceRef: source._id, total: 0, balance: 0 });
    await Record.updateOne({ _id: source._id }, { $set: { projection: { status: 'REVIEW', links: [],
      warnings: ['Ausente de la instantánea Contífico 30/09/2026; API directa HTTP 400'], projectedAt: new Date() } } });
    report.backup = backup;
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
