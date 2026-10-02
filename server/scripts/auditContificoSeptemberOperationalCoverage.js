#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const InventoryMovement = require('../models/InventoryMovement');
const BankTransaction = require('../models/BankTransaction');
const Payroll = require('../models/Payroll');
const Note = require('../models/CreditDebitNote');
const { decodeCompressedJson } = require('../utils/compressedJson');

const range = { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') };

async function coverage(clinic, entity, model) {
  const source = await Record.find({ clinic: clinic._id, entity, 'search.date': range })
    .select('_id externalId projection.status projection.warnings').lean();
  const local = await model.find({ clinic: clinic._id, sourceModel: 'ContificoRecord',
    sourceRef: { $in: source.map((row) => row._id) } }).select('sourceRef').lean();
  const localByRef = new Map();
  for (const row of local) localByRef.set(String(row.sourceRef), (localByRef.get(String(row.sourceRef)) || 0) + 1);
  return { archived: source.length, local: local.length,
    withoutLocal: source.filter((row) => !localByRef.has(String(row._id))).length,
    withMultipleLocal: [...localByRef.values()].filter((count) => count > 1).length,
    review: source.filter((row) => row.projection?.status === 'REVIEW').length,
    error: source.filter((row) => row.projection?.status === 'ERROR').length,
    missingSamples: source.filter((row) => !localByRef.has(String(row._id))).slice(0, 20)
      .map((row) => ({ id: row.externalId, projection: row.projection?.status,
        warnings: row.projection?.warnings })) };
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [inventory, bank, roles, localPayroll, localNotes] = await Promise.all([
    coverage(clinic, 'inventory_movement', InventoryMovement),
    coverage(clinic, 'bank_movement', BankTransaction),
    Record.find({ clinic: clinic._id, entity: 'payroll_role' })
      .select('externalId payloadCompressed').lean(),
    Payroll.find({ clinic: clinic._id, year: 2026, month: 9 })
      .select('year month periodType totalNeto').lean(),
    Note.find({ clinic: clinic._id, fechaEmision: range }).select('serie total sourceModel').lean(),
  ]);
  const septemberRoles = roles.filter((row) => {
    const data = decodeCompressedJson(row.payloadCompressed);
    return Number(data.anio) === 2026 && Number(data.mes) === 9;
  });
  console.log(JSON.stringify({ inventoryMovements: inventory, bankMovements: bank,
    payroll: { archivedRoles: septemberRoles.length, localPeriods: localPayroll.length },
    notes: { local: localNotes.length, imported: localNotes.filter((row) => row.sourceModel === 'ContificoRecord').length } }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
