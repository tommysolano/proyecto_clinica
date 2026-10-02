#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const { parse } = require('csv-parse/sync');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Payment = require('../models/Payment');
const { decodeCompressedJson } = require('../utils/compressedJson');

const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
const money = (value) => +Number(String(value || '0').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')).toFixed(2);
const round = (value) => +Number(value || 0).toFixed(2);
const key = (date, id, voucher, amount) => [date, String(id || ''), String(voucher || ''), round(amount)].join('|');

async function main() {
  if (!input) throw new Error('Falta --input');
  const gui = parse(fs.readFileSync(input, 'utf8'), { delimiter: '\t', columns: true,
    relax_quotes: true, relax_column_count: true, skip_empty_lines: true })
    .filter((row) => row.Tipo === 'Cobro' && /^\d{2}\/09\/2026$/.test(row.Fecha));
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [records, local] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'transaction', 'search.type': 'C',
      'search.date': { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
      .select('externalId payloadCompressed projection').lean(),
    Payment.find({ clinic: clinic._id, type: 'COBRO', idempotencyKey: /^contifico:transaction:/,
      date: { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
      .select('idempotencyKey date total applications appliedAmount advanceAmount journalEntry bankAccount').lean(),
  ]);
  const source = records.map((record) => ({ id: record.externalId,
    payload: decodeCompressedJson(record.payloadCompressed), projection: record.projection?.status }));
  const people = await Record.find({ clinic: clinic._id, entity: 'person',
    externalId: { $in: [...new Set(source.map((row) => row.payload.persona_id).filter(Boolean))] } })
    .select('externalId payloadCompressed').lean();
  const idByPerson = new Map(people.map((row) => { const person = decodeCompressedJson(row.payloadCompressed);
    return [row.externalId, String(person.ruc || person.cedula || '')]; }));
  const guiCounts = new Map();
  for (const row of gui) { const k = key(row.Fecha, row['Identificación'], row['#Comprobante'], money(row.Valor));
    guiCounts.set(k, (guiCounts.get(k) || 0) + 1); }
  const sourceCounts = new Map();
  for (const row of source) { const data = row.payload;
    const k = key(data.fecha_emision, idByPerson.get(data.persona_id), data.numero_comprobante, data.total);
    sourceCounts.set(k, (sourceCounts.get(k) || 0) + 1); }
  const guiOnly = [], sourceOnly = [];
  for (const [k, count] of guiCounts) if (count > (sourceCounts.get(k) || 0))
    guiOnly.push({ key: k, count: count - (sourceCounts.get(k) || 0) });
  for (const [k, count] of sourceCounts) if (count > (guiCounts.get(k) || 0))
    sourceOnly.push({ key: k, count: count - (guiCounts.get(k) || 0) });
  const localById = new Map(local.map((row) => [row.idempotencyKey.slice('contifico:transaction:'.length), row]));
  const missing = [], fieldDifferences = [];
  for (const row of source) {
    const payment = localById.get(row.id);
    if (!payment) { missing.push(row.id); continue; }
    if (round(payment.total) !== round(row.payload.total)) fieldDifferences.push({ id: row.id,
      source: round(row.payload.total), local: round(payment.total) });
  }
  const report = { gui: { count: gui.length, total: round(gui.reduce((sum, row) => sum + money(row.Valor), 0)) },
    source: { count: source.length, total: round(source.reduce((sum, row) => sum + Number(row.payload.total || 0), 0)) },
    local: { count: local.length, total: round(local.reduce((sum, row) => sum + Number(row.total || 0), 0)),
      withoutJournalLink: local.filter((row) => !row.journalEntry).length },
    guiOnly: guiOnly.length, guiOnlySamples: guiOnly.slice(0, 15),
    sourceOnly: sourceOnly.length, sourceOnlySamples: sourceOnly.slice(0, 15),
    missingLocal: missing.length, missingSamples: missing.slice(0, 15),
    amountDifferences: fieldDifferences.length, amountDifferenceSamples: fieldDifferences.slice(0, 15) };
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
