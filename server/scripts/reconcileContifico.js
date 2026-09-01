#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const ChartOfAccount = require('../models/ChartOfAccount');
const CostCenter = require('../models/CostCenter');
const InventoryCategory = require('../models/InventoryCategory');
const Warehouse = require('../models/Warehouse');
const BankAccount = require('../models/BankAccount');
const Patient = require('../models/Patient');
const Supplier = require('../models/Supplier');
const Product = require('../models/Product');
const FiscalPeriod = require('../models/FiscalPeriod');
const JournalEntry = require('../models/JournalEntry');
const AccountBalance = require('../models/AccountBalance');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const ContificoRecord = require('../models/ContificoRecord');
const { checksum } = require('./migrateContifico');
const { decodeCompressedJson } = require('../utils/compressedJson');

const mb = (value) => Math.round((Number(value || 0) / 1048576) * 10) / 10;

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);
  const db = mongoose.connection.db;
  const clinic = await db.collection('clinics').findOne({ name: /^Shiluv$/i });
  if (!clinic) throw new Error('Clinica Shiluv no encontrada');
  const matchClinic = { clinic: clinic._id };
  const [stats, archiveStats, journalStats, rawJournalStatuses, entityCounts, projectionCounts, reviewReasons, lastRun,
    chartAccounts, costCenters, categories, warehouses, bankAccounts, importedPatients, importedSuppliers, products,
    fiscalPeriods, accountBalanceStats, receivableStats, payableStats, journalIntegrity, projectionLinkCounts] = await Promise.all([
    db.command({ dbStats: 1 }),
    db.command({ collStats: 'contificorecords' }),
    db.collection('journalentries').aggregate([
      { $match: matchClinic },
      { $group: {
        _id: '$source',
        count: { $sum: 1 },
        lines: { $sum: { $size: '$lines' } },
        debit: { $sum: '$totalDebit' },
        credit: { $sum: '$totalCredit' },
      } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    db.collection('contificorecords').aggregate([
      { $match: { ...matchClinic, entity: 'journal_entry' } },
      { $group: { _id: '$projection.status', count: { $sum: 1 }, compressedBytes: { $sum: { $binarySize: '$payloadCompressed' } } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    db.collection('contificorecords').aggregate([
      { $match: matchClinic },
      { $group: { _id: '$entity', count: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]).toArray(),
    db.collection('contificorecords').aggregate([
      { $match: matchClinic },
      { $group: { _id: { entity: '$entity', status: '$projection.status' }, count: { $sum: 1 } } },
      { $sort: { '_id.entity': 1, '_id.status': 1 } },
    ]).toArray(),
    db.collection('contificorecords').aggregate([
      { $match: { ...matchClinic, entity: 'journal_entry', 'projection.status': 'REVIEW' } },
      { $project: { reason: { $arrayElemAt: ['$projection.warnings', 0] } } },
      { $group: { _id: '$reason', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
    ]).toArray(),
    db.collection('contificomigrationruns').find({ ...matchClinic, phase: 'PROJECT' }).sort({ createdAt: -1 }).limit(1).toArray(),
    ChartOfAccount.countDocuments(matchClinic),
    CostCenter.countDocuments(matchClinic),
    InventoryCategory.countDocuments(matchClinic),
    Warehouse.countDocuments(matchClinic),
    BankAccount.countDocuments(matchClinic),
    Patient.countDocuments({ ...matchClinic, notes: /^Contifico / }),
    Supplier.countDocuments({ ...matchClinic, notes: /^Contifico / }),
    Product.countDocuments(matchClinic),
    FiscalPeriod.countDocuments(matchClinic),
    AccountBalance.aggregate([
      { $match: matchClinic },
      { $group: { _id: null, count: { $sum: 1 }, debit: { $sum: '$debit' }, credit: { $sum: '$credit' } } },
    ]),
    Receivable.aggregate([
      { $match: { ...matchClinic, sourceModel: 'ContificoRecord' } },
      { $group: { _id: null, count: { $sum: 1 }, balance: { $sum: '$balance' }, missingParty: { $sum: { $cond: [{ $eq: ['$party.ref', null] }, 1, 0] } }, missingAccount: { $sum: { $cond: [{ $eq: ['$account', null] }, 1, 0] } } } },
    ]),
    Payable.aggregate([
      { $match: { ...matchClinic, sourceModel: 'ContificoRecord' } },
      { $group: { _id: null, count: { $sum: 1 }, balance: { $sum: '$balance' }, missingParty: { $sum: { $cond: [{ $eq: ['$party.ref', null] }, 1, 0] } }, missingAccount: { $sum: { $cond: [{ $eq: ['$account', null] }, 1, 0] } } } },
    ]),
    JournalEntry.aggregate([
      { $match: { ...matchClinic, source: 'MIGRACION' } },
      { $group: { _id: null, count: { $sum: 1 }, unbalanced: { $sum: { $cond: [{ $gt: [{ $abs: { $subtract: ['$totalDebit', '$totalCredit'] } }, 0.01] }, 1, 0] } }, missingSourceRef: { $sum: { $cond: [{ $eq: ['$sourceRef', null] }, 1, 0] } } } },
    ]),
    ContificoRecord.aggregate([
      { $match: matchClinic },
      { $unwind: '$projection.links' },
      { $group: { _id: { model: '$projection.links.model', ref: '$projection.links.ref' } } },
      { $group: { _id: '$_id.model', uniqueTargets: { $sum: 1 } } },
      { $sort: { _id: 1 } },
    ]),
  ]);
  const supplierLinkRows = await ContificoRecord.aggregate([
    { $match: matchClinic },
    { $unwind: '$projection.links' },
    { $match: { 'projection.links.model': 'Supplier' } },
    { $group: { _id: '$projection.links.ref' } },
  ]);
  const supplierLinkIds = supplierLinkRows.map((row) => row._id);
  const unlinkedImportedSuppliers = await Supplier.countDocuments({ ...matchClinic, notes: /^Contifico /, _id: { $nin: supplierLinkIds } });
  const unlinkedSupplierRefs = await Promise.all([
    Receivable.countDocuments({ ...matchClinic, 'party.ref': { $nin: supplierLinkIds }, 'party.model': 'Supplier', sourceModel: 'ContificoRecord' }),
    Payable.countDocuments({ ...matchClinic, 'party.ref': { $nin: supplierLinkIds }, 'party.model': 'Supplier', sourceModel: 'ContificoRecord' }),
  ]);
  let deepArchiveCheck = null;
  if (process.argv.includes('--deep')) {
    deepArchiveCheck = { checked: 0, decodeErrors: 0, checksumMismatches: 0 };
    const cursor = ContificoRecord.find(matchClinic).select('checksum payloadCompressed').lean().cursor({ batchSize: 500 });
    for await (const record of cursor) {
      try {
        const payload = decodeCompressedJson(record.payloadCompressed);
        if (checksum(payload) !== record.checksum) deepArchiveCheck.checksumMismatches += 1;
      } catch (_error) {
        deepArchiveCheck.decodeErrors += 1;
      }
      deepArchiveCheck.checked += 1;
    }
  }
  console.log(JSON.stringify({
    clinic: { id: String(clinic._id), name: clinic.name },
    database: { dataMB: mb(stats.dataSize), storageMB: mb(stats.storageSize), indexMB: mb(stats.indexSize) },
    archive: { count: archiveStats.count, logicalMB: mb(archiveStats.size), storageMB: mb(archiveStats.storageSize), indexMB: mb(archiveStats.totalIndexSize) },
    deepArchiveCheck,
    entities: entityCounts,
    projections: projectionCounts,
    targets: { chartAccounts, costCenters, categories, warehouses, bankAccounts, importedPatients, importedSuppliers, products, fiscalPeriods },
    projectionLinks: projectionLinkCounts,
    unlinkedImportedSuppliers: { count: unlinkedImportedSuppliers, referencedByReceivables: unlinkedSupplierRefs[0], referencedByPayables: unlinkedSupplierRefs[1] },
    journals: journalStats,
    journalIntegrity: journalIntegrity[0] || { count: 0, unbalanced: 0, missingSourceRef: 0 },
    rawJournalStatuses: rawJournalStatuses.map((row) => ({ ...row, compressedMB: mb(row.compressedBytes) })),
    reviewReasons,
    accountBalances: accountBalanceStats[0] || { count: 0, debit: 0, credit: 0 },
    receivables: receivableStats[0] || { count: 0, balance: 0, missingParty: 0, missingAccount: 0 },
    payables: payableStats[0] || { count: 0, balance: 0, missingParty: 0, missingAccount: 0 },
    lastProjectRun: lastRun[0] && { status: lastRun[0].status, createdAt: lastRun[0].createdAt, completedAt: lastRun[0].completedAt, finalIssue: lastRun[0].issues?.at(-1) },
  }, null, 2));
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));
