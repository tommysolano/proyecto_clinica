#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const { parse } = require('csv-parse/sync');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const { ContificoApi } = require('../services/contificoApi');
const { checksum, search } = require('./migrateContifico');

const sourceIds = ['YjbqlWynyT8G8ZaL', 'loej0NmMlHnkn8bQ', 'xmbmYgp09TjGjzbo', 'JvaMJxlNGSqGqXbp'];
const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
const round = (value) => +Number(value || 0).toFixed(2);
const money = (value) => +Number(String(value || '0').replace(/\./g, '').replace(',', '.')).toFixed(2);
const upper = (value) => String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();

async function main() {
  if (!input) throw new Error('Falta --input');
  const commit = process.argv.includes('--commit');
  const gui = parse(fs.readFileSync(input, 'utf8'), { delimiter: '\t', columns: true,
    relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const docs = [];
  for (const id of sourceIds) docs.push(await api.get(`/api/v2/documento/${id}/`));
  const pairs = [];
  for (const doc of docs) {
    const screen = gui.filter((row) => row['Tipo Registro'] === 'Proveedor' &&
      row['# Documento'] === doc.documento && row['Tipo Documento'].startsWith('Comprobante de Anticipo'));
    if (doc.tipo_documento !== 'DAC' || doc.anulado || round(doc.saldo) !== 0 || screen.length !== 1 ||
        money(screen[0].Total) !== round(doc.total) || money(screen[0].Saldo) !== 0 ||
        screen[0].Descripción !== doc.descripcion) throw new Error(`Anticipo ${doc.id} difiere del exporte`);
    const journals = [];
    for await (const page of api.pages('/api/v2/contabilidad/asiento/',
      { fecha_inicial: doc.fecha_emision, fecha_final: doc.fecha_emision }, 100, {})) journals.push(...page.rows);
    const matches = journals.filter((journal) => journal.fecha === doc.fecha_emision &&
      upper(journal.glosa) === upper(doc.descripcion) &&
      journal.detalles?.some((line) => line.cuenta_id === 'RMdR77ROsv8vEel6' && line.tipo === 'H' && round(line.valor) === round(doc.total)) &&
      journal.detalles?.some((line) => line.cuenta_id === 'O8bYRRzMhLPLMd7j' && line.tipo === 'D' && round(line.valor) === round(doc.total)));
    if (matches.length !== 1) throw new Error(`Anticipo ${doc.id}: ${matches.length} asientos de reconocimiento`);
    pairs.push({ document: doc, journal: matches[0] });
  }
  if (new Set(pairs.map((pair) => pair.journal.id)).size !== 4) throw new Error('Asiento duplicado');
  const existing = await Record.find({ clinic: clinic._id, $or: [
    { entity: 'document', externalId: { $in: sourceIds } },
    { entity: 'journal_entry', externalId: { $in: pairs.map((pair) => pair.journal.id) } },
  ] }).lean();
  const report = { mode: commit ? 'COMMIT' : 'DRY_RUN', count: 4,
    total: round(docs.reduce((sum, doc) => sum + Number(doc.total), 0)),
    previousSourceRecords: existing.length,
    pairs: pairs.map((pair) => ({ documentId: pair.document.id, journalId: pair.journal.id,
      number: pair.document.documento, total: round(pair.document.total) })) };
  if (commit) {
    const folder = path.resolve(__dirname, '..', 'storage', 'contifico-batches');
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(folder, `September-2026-advances-before-${stamp}.ndjson.gz`);
    fs.writeFileSync(backup, zlib.gzipSync(Buffer.from(existing.map((row) =>
      EJSON.stringify(row, { relaxed: false })).join('\n') + '\n'), { level: 9 }), { flag: 'wx' });
    const now = new Date();
    await Record.bulkWrite(pairs.flatMap((pair) => [['document', pair.document], ['journal_entry', pair.journal]])
      .map(([entity, payload]) => ({ updateOne: {
        filter: { clinic: clinic._id, entity, externalId: payload.id },
        update: { $set: { payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }),
          payloadEncoding: 'gzip-json', checksum: checksum(payload), capturedAt: now, search: search(entity, payload) },
        $setOnInsert: { clinic: clinic._id, entity, externalId: payload.id,
          projection: { status: 'ARCHIVED', links: [], warnings: [] } } }, upsert: true,
      } })), { ordered: false });
    const manifest = path.join(folder, `September-2026-advances-pairs-${stamp}.json`);
    fs.writeFileSync(manifest, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    report.backup = backup; report.manifest = manifest;
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
