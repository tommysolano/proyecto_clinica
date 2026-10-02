#!/usr/bin/env node
'use strict';

// Recupera las 25 facturas de septiembre comprobadas contra el exporte GUI y
// sus asientos originales. Solo actualiza el archivo fuente, no la contabilidad.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const { parse } = require('csv-parse/sync');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const Journal = require('../models/JournalEntry');
const { ContificoApi } = require('../services/contificoApi');
const { checksum, search, parseDate } = require('./migrateContifico');

const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
const changedIds = new Set([
  'KBe1GPJOqFMKM3bX', 'RMdRPD3mwFv8vEal', 'KVeZzN7xgf5y5le8',
  '9jaKLv3N8H202Obk', 'pgengjwApF7Q7vaN', 'j6e9DP0zzIkPkQdW',
  'O8bYyN3JYfLPLMb7', 'gQbWQX3EoH5v5Oe6', '1qdGMo3k5t1o1kaN',
  'LqdPzA3k6FKqKWal', 'wKe5RXNvXsZOZEa3', 'EMax2wKWPI1K1kd5',
  'Y4ermnAGLi8X8Ed2', 'Arb6B4OpNHrxrzby', 'MEegnNmWjhAnA9dQ',
  'RBe3yPLmpipVpqbL', 'j6e9DP0vYFkPkQdW',
]);
const missingNumbers = new Set(Array.from({ length: 8 }, (_, index) =>
  `001-100-${String(238 - index).padStart(9, '0')}`));
const payableSourceAccountId = 'RMdR77ROsv8vEel6';
const round = (value) => +Number(value || 0).toFixed(2);
const money = (value) => +Number(String(value || '0').replace(/\./g, '').replace(',', '.')).toFixed(2);
const day = (value) => {
  const raw = String(value || '');
  const full = /^\d{2}\/\d{2}\/\d{2}$/.test(raw) ? `${raw.slice(0, 6)}20${raw.slice(6)}` : raw;
  return parseDate(full)?.toISOString().slice(0, 10) || '';
};
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();

async function main() {
  if (!input) throw new Error('Falta --input=exporte de Contífico');
  const commit = process.argv.includes('--commit');
  const screen = parse(fs.readFileSync(input, 'utf8'), { delimiter: '\t', columns: true,
    relax_quotes: true, relax_column_count: true, skip_empty_lines: true })
    .filter((row) => row['Tipo Registro'] === 'Proveedor');
  const idColumn = Object.keys(screen[0])[9];
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 2, timeoutMs: 20000 });
  const docs = [];
  for await (const page of api.pages('/api/v2/documento/', { tipo_registro: 'PRO',
    fecha_inicial: '01/09/2026', fecha_final: '30/09/2026' }, 100, {}))
    docs.push(...page.rows.filter((row) => changedIds.has(row.id) || missingNumbers.has(row.documento)));
  if (docs.length !== 25 || docs.filter((row) => changedIds.has(row.id)).length !== 17 ||
      docs.filter((row) => missingNumbers.has(row.documento)).length !== 8 ||
      new Set(docs.map((row) => row.id)).size !== 25) throw new Error('No se recuperaron las 25 facturas esperadas');
  const journals = [];
  for (const [from, through] of [['23/09/2026', '25/09/2026'], ['30/09/2026', '30/09/2026']])
    for await (const page of api.pages('/api/v2/contabilidad/asiento/',
      { fecha_inicial: from, fecha_final: through }, 100, {})) journals.push(...page.rows);
  const pairs = [];
  for (const doc of docs) {
    if (doc.tipo_documento !== 'FAC' || doc.anulado || round(doc.total) <= 0) throw new Error(`${doc.id}: factura no elegible`);
    const gui = screen.filter((row) => row['Tipo Documento'] === 'Factura' &&
      day(row.Fecha) === day(doc.fecha_emision) && row['# Documento'] === doc.documento &&
      row['Autorización'] === doc.autorizacion && row[idColumn] === doc.persona?.ruc);
    if (gui.length !== 1 || money(gui[0].Total) !== round(doc.total) ||
        money(gui[0].IVA) !== round(doc.iva) || money(gui[0].Saldo) !== round(doc.saldo) ||
        gui[0].Estado !== 'Pendiente') throw new Error(`${doc.id}: GUI y API no coinciden`);
    const matches = journals.filter((journal) => journal.fecha === doc.fecha_emision &&
      clean(journal.glosa) === clean(doc.descripcion) &&
      journal.detalles?.some((line) => line.cuenta_id === payableSourceAccountId &&
        line.tipo === 'H' && round(line.valor) === round(doc.total)));
    if (matches.length !== 1) throw new Error(`${doc.id}: asiento no inequívoco (${matches.length})`);
    const journal = matches[0];
    const debit = round(journal.detalles.reduce((sum, line) => sum + (line.tipo === 'D' ? Number(line.valor) : 0), 0));
    const credit = round(journal.detalles.reduce((sum, line) => sum + (line.tipo === 'H' ? Number(line.valor) : 0), 0));
    if (debit !== credit) throw new Error(`${doc.id}: asiento descuadrado`);
    pairs.push({ document: doc, journal });
  }
  if (new Set(pairs.map((pair) => pair.journal.id)).size !== 25)
    throw new Error('Un asiento se asignó a más de una factura');
  const docIds = pairs.map((pair) => pair.document.id);
  const journalIds = pairs.map((pair) => pair.journal.id);
  const existing = await Record.find({ clinic: clinic._id, $or: [
    { entity: 'document', externalId: { $in: docIds } },
    { entity: 'journal_entry', externalId: { $in: journalIds } },
  ] }).lean();
  const docsById = new Map(existing.filter((row) => row.entity === 'document').map((row) => [row.externalId, row]));
  const journalsById = new Map(existing.filter((row) => row.entity === 'journal_entry').map((row) => [row.externalId, row]));
  const localDocs = await Purchase.find({ clinic: clinic._id, sourceModel: 'ContificoRecord',
    sourceRef: { $in: [...docsById.values()].map((row) => row._id) } }).select('sourceRef total balance').lean();
  const localJournals = await Journal.find({ clinic: clinic._id, sourceModel: 'ContificoRecord',
    sourceRef: { $in: [...journalsById.values()].map((row) => row._id) } }).select('sourceRef').lean();
  const report = { mode: commit ? 'COMMIT' : 'DRY_RUN', documents: pairs.length,
    documentTotal: round(pairs.reduce((sum, pair) => sum + Number(pair.document.total), 0)),
    documentOpenBalance: round(pairs.reduce((sum, pair) => sum + Number(pair.document.saldo), 0)),
    localPurchasesBefore: localDocs.length, archivedDocumentsBefore: docsById.size,
    archivedJournalsBefore: journalsById.size, localJournalsBefore: localJournals.length,
    pairs: pairs.map((pair) => ({ documentId: pair.document.id, number: pair.document.documento,
      journalId: pair.journal.id, total: round(pair.document.total), balance: round(pair.document.saldo) })) };
  if (commit) {
    const folder = path.resolve(__dirname, '..', 'storage', 'contifico-batches');
    fs.mkdirSync(folder, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backup = path.join(folder, `September-2026-before-${stamp}.ndjson.gz`);
    fs.writeFileSync(backup, zlib.gzipSync(Buffer.from(existing.map((row) =>
      EJSON.stringify(row, { relaxed: false })).join('\n') + '\n'), { level: 9 }), { flag: 'wx' });
    report.archiveBackup = backup;
    const now = new Date();
    const ops = pairs.flatMap((pair) => [['document', pair.document], ['journal_entry', pair.journal]])
      .map(([entity, payload]) => ({ updateOne: {
        filter: { clinic: clinic._id, entity, externalId: payload.id },
        update: { $set: { payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }),
          payloadEncoding: 'gzip-json', checksum: checksum(payload), capturedAt: now, search: search(entity, payload) },
        $setOnInsert: { clinic: clinic._id, entity, externalId: payload.id,
          projection: { status: 'ARCHIVED', links: [], warnings: [] } } },
        upsert: true,
      } }));
    await Record.bulkWrite(ops, { ordered: false });
    const manifest = path.join(folder, `September-2026-pairs-${stamp}.json`);
    fs.writeFileSync(manifest, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
    report.manifest = manifest;
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
