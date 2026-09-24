#!/usr/bin/env node
'use strict';

/**
 * Retira de los modelos operativos exclusivamente proyecciones cuyo registro ya
 * no existe en la última instantánea completa de Contífico. La copia cruda se
 * conserva y queda marcada REVIEW, por lo que la operación es auditable.
 *
 *   node scripts/retireMissingContificoSnapshotRecords.js --clinic-name=Central
 *   node scripts/retireMissingContificoSnapshotRecords.js --clinic-name=Central --commit
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ContificoRecord = require('../models/ContificoRecord');
const ContificoMigrationRun = require('../models/ContificoMigrationRun');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payment = require('../models/Payment');
const BankTransaction = require('../models/BankTransaction');
const InventoryMovement = require('../models/InventoryMovement');
const JournalEntry = require('../models/JournalEntry');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const CreditDebitNote = require('../models/CreditDebitNote');

const entityByStage = {
  documents: 'document', transactions: 'transaction', bank_movements: 'bank_movement',
  inventory_movements: 'inventory_movement', journal_entries: 'journal_entry',
};

function args(argv) {
  const values = {}, flags = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const at = arg.indexOf('=');
    if (at < 0) flags.add(arg.slice(2)); else values[arg.slice(2, at)] = arg.slice(at + 1);
  }
  return { commit: flags.has('commit'), clinicName: values['clinic-name'] || 'Central', clinicId: values.clinic || null };
}

async function countAndDelete(model, filter, commit) {
  const count = await model.countDocuments(filter);
  if (commit && count) await model.deleteMany(filter);
  return count;
}

async function main() {
  const options = args(process.argv.slice(2));
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = options.clinicId
    ? await Clinic.findById(options.clinicId).lean()
    : await Clinic.findOne({ name: new RegExp(`^${String(options.clinicName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  if (!clinic) throw new Error('Clínica destino no encontrada');
  const snapshot = await ContificoMigrationRun.findOne({
    clinic: clinic._id, phase: 'EXTRACT', status: { $in: ['COMPLETED', 'COMPLETED_WITH_WARNINGS'] },
  }).sort({ completedAt: -1, createdAt: -1 }).lean();
  if (!snapshot) throw new Error('No hay una instantánea completa de Contífico');
  const entities = (snapshot.stages || []).filter((stage) => stage.status === 'COMPLETED').map((stage) => entityByStage[stage.name]).filter(Boolean);
  const stale = await ContificoRecord.find({ clinic: clinic._id, entity: { $in: entities }, migrationRun: { $ne: snapshot._id } })
    .select('_id entity externalId projection').lean();
  const ids = (entity) => stale.filter((row) => row.entity === entity).map((row) => row._id);
  const docRows = stale.filter((row) => row.entity === 'document');
  const docIds = docRows.map((row) => row._id);
  const saleKeys = docRows.map((row) => `contifico:${row.externalId}`);
  const transactionKeys = stale.filter((row) => row.entity === 'transaction').map((row) => `contifico:transaction:${row.externalId}`);
  const sales = saleKeys.length ? await Sale.find({ clinic: clinic._id, idempotencyKey: { $in: saleKeys } }).select('_id invoice').lean() : [];
  const invoiceIds = sales.map((row) => row.invoice).filter(Boolean);
  const source = { clinic: clinic._id, sourceModel: 'ContificoRecord' };
  const summary = {
    mode: options.commit ? 'COMMIT' : 'DRY_RUN', snapshot: String(snapshot._id),
    sourceMissing: entities.reduce((acc, entity) => ({ ...acc, [entity]: ids(entity).length }), {}),
    operational: {
      invoices: invoiceIds.length,
      sales: await Sale.countDocuments({ clinic: clinic._id, idempotencyKey: { $in: saleKeys } }),
      purchases: await PurchaseInvoice.countDocuments({ ...source, sourceRef: { $in: docIds } }),
      receivables: await Receivable.countDocuments({ ...source, sourceRef: { $in: docIds } }),
      payables: await Payable.countDocuments({ ...source, sourceRef: { $in: docIds } }),
      notes: await CreditDebitNote.countDocuments({ ...source, sourceRef: { $in: docIds } }),
      payments: await Payment.countDocuments({ clinic: clinic._id, idempotencyKey: { $in: transactionKeys } }),
      bankTransactions: await BankTransaction.countDocuments({ ...source, sourceRef: { $in: ids('bank_movement') } }),
      inventoryMovements: await InventoryMovement.countDocuments({ ...source, sourceRef: { $in: ids('inventory_movement') } }),
      journalEntries: await JournalEntry.countDocuments({ ...source, sourceRef: { $in: ids('journal_entry') } }),
    },
  };
  console.log(JSON.stringify(summary, null, 2));
  if (!options.commit || !stale.length) return;
  await Promise.all([
    invoiceIds.length ? Invoice.deleteMany({ _id: { $in: invoiceIds } }) : null,
    saleKeys.length ? Sale.deleteMany({ clinic: clinic._id, idempotencyKey: { $in: saleKeys } }) : null,
    docIds.length ? PurchaseInvoice.deleteMany({ ...source, sourceRef: { $in: docIds } }) : null,
    docIds.length ? Receivable.deleteMany({ ...source, sourceRef: { $in: docIds } }) : null,
    docIds.length ? Payable.deleteMany({ ...source, sourceRef: { $in: docIds } }) : null,
    docIds.length ? CreditDebitNote.deleteMany({ ...source, sourceRef: { $in: docIds } }) : null,
    transactionKeys.length ? Payment.deleteMany({ clinic: clinic._id, idempotencyKey: { $in: transactionKeys } }) : null,
    ids('bank_movement').length ? BankTransaction.deleteMany({ ...source, sourceRef: { $in: ids('bank_movement') } }) : null,
    ids('inventory_movement').length ? InventoryMovement.deleteMany({ ...source, sourceRef: { $in: ids('inventory_movement') } }) : null,
    ids('journal_entry').length ? JournalEntry.deleteMany({ ...source, sourceRef: { $in: ids('journal_entry') } }) : null,
  ].filter(Boolean));
  const warning = `Ausente de la instantánea Contífico ${snapshot._id}; proyección operativa retirada.`;
  await ContificoRecord.bulkWrite(stale.map((record) => ({ updateOne: {
    filter: { _id: record._id },
    update: { $set: { projection: { status: 'REVIEW', links: [], warnings: [warning], projectedAt: new Date() } } },
  } })), { ordered: false });
  console.log(`Retiradas ${stale.length} proyecciones de origen ausente; los JSON originales permanecen archivados.`);
}

if (require.main === module) main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));

module.exports = { args, entityByStage };
