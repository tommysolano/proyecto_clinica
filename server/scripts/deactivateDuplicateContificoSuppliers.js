#!/usr/bin/env node
'use strict';

// Conserva el registro histórico con cédula, pero deja de mostrarlo como proveedor activo
// cuando el mismo ID de persona de Contífico ya está proyectado con su RUC.
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ContificoRecord = require('../models/ContificoRecord');
const Supplier = require('../models/Supplier');
const { decodeCompressedJson } = require('../utils/compressedJson');

const REF_COLLECTIONS = ['purchaseinvoices', 'retentionvouchers', 'fixedassets', 'recurringaccounts', 'cardsettlements'];

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const [records, suppliers] = await Promise.all([
    ContificoRecord.find({ clinic: clinic._id, entity: 'person' }).select('externalId payloadCompressed').lean(),
    Supplier.find({ clinic: clinic._id }).select('_id ruc roles active notes defaultExpenseAccount defaultPayableAccount').lean(),
  ]);
  const supplierById = new Map(suppliers.map((row) => [String(row.ruc), row]));
  const duplicates = [], blocked = [];
  for (const record of records) {
    const row = decodeCompressedJson(record.payloadCompressed);
    const cedula = String(row.cedula || ''), ruc = String(row.ruc || '');
    if (!row.es_proveedor || !cedula || !ruc || cedula === ruc) continue;
    const old = supplierById.get(cedula), canonical = supplierById.get(ruc);
    if (!old || !canonical || !old.roles?.includes('PROVEEDOR')) continue;
    const sameOrigin = String(old.notes || '').includes(record.externalId)
      && String(canonical.notes || '').includes(record.externalId);
    const used = {};
    for (const collection of REF_COLLECTIONS) {
      used[collection] = await mongoose.connection.db.collection(collection).countDocuments({ clinic: clinic._id, supplier: old._id });
    }
    if (!sameOrigin || old.defaultExpenseAccount || old.defaultPayableAccount || Object.values(used).some(Boolean)) {
      blocked.push({ cedula, ruc, sameOrigin, used });
      continue;
    }
    duplicates.push({ cedula, ruc, oldId: old._id, roles: old.roles, active: old.active });
  }
  if (blocked.length) throw new Error(`Duplicados con referencias o procedencia ambigua: ${JSON.stringify(blocked)}`);
  if (commit) for (const row of duplicates) {
    await Supplier.updateOne({ _id: row.oldId, clinic: clinic._id, ruc: row.cedula, roles: 'PROVEEDOR' },
      { $pull: { roles: 'PROVEEDOR' }, $set: { active: false } });
  }
  console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', duplicates: duplicates.length,
    changed: commit ? duplicates.length : 0, retainedWithRuc: duplicates.map(({ ruc }) => ruc) }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
