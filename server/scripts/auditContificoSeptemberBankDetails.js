#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Movement = require('../models/BankTransaction');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { parseDate } = require('./migrateContifico');

const round = (value) => +Number(value || 0).toFixed(2);
const iso = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;
const link = (record, model) => (record?.projection?.links || []).find((item) => item.model === model)?.ref || null;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [source, bankAccounts] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'bank_movement',
      'search.date': { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
      .select('_id externalId payloadCompressed projection').lean(),
    Record.find({ clinic: clinic._id, entity: 'bank_account' })
      .select('externalId projection.links').lean(),
  ]);
  const bankById = new Map(bankAccounts.map((row) => [row.externalId, link(row, 'BankAccount')]));
  const local = await Movement.find({ clinic: clinic._id, sourceModel: 'ContificoRecord',
    sourceRef: { $in: source.map((row) => row._id) } }).lean();
  const localByRef = new Map(local.map((row) => [String(row.sourceRef), row]));
  const differences = [];
  for (const record of source) {
    const row = decodeCompressedJson(record.payloadCompressed);
    const found = localByRef.get(String(record._id));
    if (!found) { differences.push({ id: record.externalId, kind: 'MISSING' }); continue; }
    const income = String(row.tipo_registro).toUpperCase() === 'I', code = String(row.tipo).toUpperCase();
    const expected = { date: iso(parseDate(row.fecha_emision)),
      bankAccount: String(bankById.get(String(row.cuenta_bancaria_id || '')) || ''),
      amount: round((row.detalles || []).reduce((sum, detail) => sum + Number(detail.monto || 0), 0)),
      direction: income ? 1 : -1,
      type: income ? code === 'D' ? 'DEPOSITO' : code === 'N' ? 'INTERES' : 'AJUSTE' :
        code === 'C' ? 'CHEQUE_EMITIDO' : code === 'T' ? 'TRANSFERENCIA_OUT' : 'PAGO',
      reference: String(row.numero_comprobante || '') };
    const actual = { date: iso(found.date), bankAccount: String(found.bankAccount || ''),
      amount: round(found.amount), direction: found.direction, type: found.type,
      reference: String(found.reference || '') };
    if (JSON.stringify(expected) !== JSON.stringify(actual)) differences.push({ id: record.externalId,
      kind: 'FIELDS', expected, actual });
  }
  console.log(JSON.stringify({ source: source.length, local: local.length,
    differences: differences.length, samples: differences.slice(0, 20) }, null, 2));
  if (differences.length || local.length !== source.length) process.exitCode = 2;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
