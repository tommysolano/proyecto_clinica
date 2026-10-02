#!/usr/bin/env node
'use strict';

// Consulta por ID las compras locales que el último listado completo de la API
// omitió. Solo lectura; detecta documentos vivos y cambios del origen.
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Run = require('../models/ContificoMigrationRun');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const { ContificoApi } = require('../services/contificoApi');
const round = (value) => +Number(value || 0).toFixed(2);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const run = await Run.findOne({ clinic: clinic._id, phase: 'EXTRACT',
    status: { $in: ['COMPLETED', 'COMPLETED_WITH_WARNINGS'] }, 'stages.name': 'documents' })
    .sort({ completedAt: -1 }).lean();
  if (!run?.stages?.some((stage) => stage.name === 'documents' && stage.status === 'COMPLETED'))
    throw new Error('Última extracción de documentos incompleta');
  const purchases = await Purchase.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' })
    .select('sourceRef total iva balance').lean();
  const records = await Record.find({ _id: { $in: purchases.map((row) => row.sourceRef) },
    migrationRun: { $ne: run._id } }).select('_id externalId').lean();
  const byRef = new Map(purchases.map((row) => [String(row.sourceRef), row]));
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 2, timeoutMs: 20000 });
  const results = [];
  let next = 0;
  async function worker() {
    while (next < records.length) {
      const record = records[next++];
      const local = byRef.get(String(record._id));
      try {
        const live = await api.get(`/api/v2/documento/${encodeURIComponent(record.externalId)}/`);
        const diff = ['total', 'iva', 'saldo'].filter((field) =>
          round(live[field]) !== round(field === 'saldo' ? local.balance : local[field]));
        results.push({ id: record.externalId, status: 'LIVE', diff,
          ...(diff.length ? { source: { total: round(live.total), iva: round(live.iva), saldo: round(live.saldo) },
            local: { total: round(local.total), iva: round(local.iva), saldo: round(local.balance) } } : {}) });
      } catch (error) {
        results.push({ id: record.externalId, status: error.status === 400 &&
          error.message.includes('Documento no encontrado.') ? 'REMOVED' : 'ERROR', http: error.status || null });
      }
      if (results.length % 50 === 0) console.log(`[coverage] ${results.length}/${records.length} verificados`);
    }
  }
  await Promise.all(Array.from({ length: 5 }, () => worker()));
  const live = results.filter((row) => row.status === 'LIVE');
  const changed = live.filter((row) => row.diff.length);
  const removed = results.filter((row) => row.status === 'REMOVED');
  const errors = results.filter((row) => row.status === 'ERROR');
  console.log(JSON.stringify({ snapshot: String(run._id), omittedFromList: records.length,
    live: live.length, changed: changed.length, changedSamples: changed.slice(0, 30),
    removed: removed.length, removedSamples: removed.slice(0, 30), errors: errors.length,
    errorSamples: errors.slice(0, 30), requests: api.metrics.requests }, null, 2));
  if (changed.length || removed.length || errors.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
