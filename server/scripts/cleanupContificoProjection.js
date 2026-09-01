#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Supplier = require('../models/Supplier');
const ContificoRecord = require('../models/ContificoRecord');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const Payment = require('../models/Payment');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const RetentionVoucher = require('../models/RetentionVoucher');
const CardSettlement = require('../models/CardSettlement');
const FixedAsset = require('../models/FixedAsset');
const RecurringAccount = require('../models/RecurringAccount');

async function main() {
  const commit = process.argv.includes('--commit');
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Shiluv$/i }).lean();
  if (!clinic) throw new Error('Clinica Shiluv no encontrada');

  const linkedRows = await ContificoRecord.aggregate([
    { $match: { clinic: clinic._id } },
    { $unwind: '$projection.links' },
    { $match: { 'projection.links.model': 'Supplier' } },
    { $group: { _id: '$projection.links.ref' } },
  ]);
  const linkedIds = linkedRows.map((row) => row._id);
  const candidates = await Supplier.find({
    clinic: clinic._id,
    notes: /^Contifico /,
    _id: { $nin: linkedIds },
  }).select('_id createdAt').lean();
  const candidateIds = candidates.map((row) => row._id);
  const referenceQueries = [
    ['receivables', Receivable.distinct('party.ref', { clinic: clinic._id, 'party.ref': { $in: candidateIds } })],
    ['payables', Payable.distinct('party.ref', { clinic: clinic._id, 'party.ref': { $in: candidateIds } })],
    ['payments', Payment.distinct('partyRef', { clinic: clinic._id, partyModel: 'Supplier', partyRef: { $in: candidateIds } })],
    ['purchaseInvoices', PurchaseInvoice.distinct('supplier', { clinic: clinic._id, supplier: { $in: candidateIds } })],
    ['retentionVouchers', RetentionVoucher.distinct('supplier', { clinic: clinic._id, supplier: { $in: candidateIds } })],
    ['cardSettlements', CardSettlement.distinct('supplier', { clinic: clinic._id, supplier: { $in: candidateIds } })],
    ['fixedAssets', FixedAsset.distinct('supplier', { clinic: clinic._id, supplier: { $in: candidateIds } })],
    ['recurringAccounts', RecurringAccount.distinct('supplier', { clinic: clinic._id, supplier: { $in: candidateIds } })],
  ];
  const referenceResults = await Promise.all(referenceQueries.map(async ([name, query]) => [name, await query]));
  const referenced = new Set(referenceResults.flatMap(([, ids]) => ids.map(String)));
  const safeIds = candidateIds.filter((id) => !referenced.has(String(id)));
  const createdTimes = candidates.map((row) => row.createdAt).filter(Boolean).sort((a, b) => a - b);
  const report = {
    mode: commit ? 'COMMIT' : 'DRY_RUN',
    linkedSupplierTargets: linkedIds.length,
    staleCandidates: candidates.length,
    referencedCandidates: referenced.size,
    safeToDelete: safeIds.length,
    references: Object.fromEntries(referenceResults.map(([name, ids]) => [name, ids.length])),
    createdAtRange: createdTimes.length ? { first: createdTimes[0], last: createdTimes.at(-1) } : null,
    deleted: 0,
  };
  if (commit && safeIds.length) {
    const result = await Supplier.deleteMany({ clinic: clinic._id, notes: /^Contifico /, _id: { $in: safeIds } });
    report.deleted = result.deletedCount;
    if (report.deleted !== safeIds.length) throw new Error(`Limpieza incompleta: esperados ${safeIds.length}, eliminados ${report.deleted}`);
  }
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));
