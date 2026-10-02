#!/usr/bin/env node
'use strict';

// Audita compras por documento, sin ocultar registros históricos retirados.
// Uso: node scripts/auditContificoPurchases.js --cutoff=30/09/2026
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ContificoMigrationRun = require('../models/ContificoMigrationRun');
const ContificoRecord = require('../models/ContificoRecord');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { parseDate } = require('./migrateContifico');

const allowed = new Set(['FAC', 'NVE', 'LQC', 'DNA', 'DAC', 'NCT']);
const round = (value) => +Number(value || 0).toFixed(2);
const dateKey = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;
const arg = (name) => process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const cutoff = parseDate(arg('cutoff') || '30/09/2026');
  if (!cutoff) throw new Error('Corte inválido');
  const snapshot = await ContificoMigrationRun.findOne({ clinic: clinic._id, phase: 'EXTRACT',
    status: { $in: ['COMPLETED', 'COMPLETED_WITH_WARNINGS'] }, 'stages.name': 'documents' })
    .sort({ completedAt: -1 }).lean();
  if (!snapshot?.stages?.some((stage) => stage.name === 'documents' && stage.status === 'COMPLETED'))
    throw new Error('No hay extracción completa de documentos');

  const [records, local] = await Promise.all([
    ContificoRecord.find({ clinic: clinic._id, entity: 'document', 'search.date': { $lte: cutoff } })
      .select('_id externalId migrationRun payloadCompressed projection').lean(),
    PurchaseInvoice.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' })
      .select('sourceRef serie fechaEmision total iva balance').lean(),
  ]);
  const localByRef = new Map(local.map((row) => [String(row.sourceRef), row]));
  const eligible = [], retired = [], unsupported = [], differences = [];
  for (const record of records) {
    const source = decodeCompressedJson(record.payloadCompressed);
    const date = parseDate(source.fecha_emision);
    if (String(source.tipo_registro).toUpperCase() !== 'PRO' || !date || date > cutoff) continue;
    const type = String(source.tipo_documento).toUpperCase();
    if (!allowed.has(type)) { unsupported.push({ id: record.externalId, type, total: round(source.total) }); continue; }
    const old = record.projection?.status === 'REVIEW' &&
      (record.projection.warnings || []).some((warning) => warning.startsWith('Ausente de la instantánea Contífico '));
    if (old) { retired.push({ id: record.externalId, type, total: round(source.total), balance: round(source.saldo) }); continue; }
    eligible.push(record);
    const actual = localByRef.get(String(record._id));
    const expected = { number: String(source.documento || ''), date: dateKey(date),
      total: round(source.total), iva: round(source.iva), balance: Math.max(0, round(source.saldo)) };
    if (!actual) { differences.push({ id: record.externalId, kind: 'MISSING', expected }); continue; }
    const observed = { number: actual.serie, date: dateKey(actual.fechaEmision),
      total: round(actual.total), iva: round(actual.iva), balance: round(actual.balance) };
    if (JSON.stringify(expected) !== JSON.stringify(observed)) differences.push({ id: record.externalId, kind: 'FIELDS', expected, observed });
  }
  const eligibleRefs = new Set(eligible.map((record) => String(record._id)));
  const extras = local.filter((row) => !eligibleRefs.has(String(row.sourceRef)));
  const recordByRef = new Map(records.map((record) => [String(record._id), record]));
  const currentRefs = new Set(eligible.filter((record) => String(record.migrationRun) === String(snapshot._id))
    .map((record) => String(record._id)));
  const report = { cutoff: dateKey(cutoff), snapshot: String(snapshot._id), archivedDocuments: records.length,
    eligibleArchivedPurchases: eligible.length, localPurchases: local.length,
    eligibleTotal: round(eligible.reduce((sum, record) => sum + Number(decodeCompressedJson(record.payloadCompressed).total || 0), 0)),
    localTotal: round(local.reduce((sum, row) => sum + row.total, 0)),
    differences: differences.length, differenceSamples: differences.slice(0, 30),
    retired, unsupported, extraLocalCount: extras.length,
    extraLocalSamples: extras.slice(0, 20).map((row) => ({ id: recordByRef.get(String(row.sourceRef))?.externalId || null,
      total: round(row.total) })),
    latestSnapshotSupportedPurchases: currentRefs.size,
    eligibleArchivedNotInLatestSnapshot: eligible.length - currentRefs.size,
    coverage: eligible.length === currentRefs.size ? 'LATEST_SNAPSHOT_COMPLETE' : 'DETAIL_VERIFICATION_REQUIRED',
  };
  console.log(JSON.stringify(report, null, 2));
  if (differences.length || extras.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
