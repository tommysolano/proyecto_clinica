#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { parse } = require('csv-parse/sync');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Journal = require('../models/JournalEntry');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
const reportFile = process.argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length);
const outputFile = process.argv.find((arg) => arg.startsWith('--output='))?.slice('--output='.length);
const money = (value) => +Number(String(value || '0').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')).toFixed(2);
const round = (value) => +Number(value || 0).toFixed(2);
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();
const key = (date, id, voucher, amount) => [date, String(id || ''), String(voucher || ''), round(amount)].join('|');

async function main() {
  if (!input || !reportFile) throw new Error('Faltan --input o --report');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  const ids = new Set(report.missingIds);
  const gui = parse(fs.readFileSync(input, 'utf8'), { delimiter: '\t', columns: true,
    relax_quotes: true, relax_column_count: true, skip_empty_lines: true })
    .filter((row) => row.Tipo === 'Cobro' && row.Fecha === '30/09/2026');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const live = (await api.listV1('/api/v1/registro/transaccion/',
    { result_size: 1000, result_page: 1 })).filter((row) => ids.has(row.id));
  const people = await Record.find({ clinic: clinic._id, entity: 'person',
    externalId: { $in: live.map((row) => row.persona_id) } }).select('externalId payloadCompressed').lean();
  const personById = new Map(people.map((record) => [record.externalId,
    decodeCompressedJson(record.payloadCompressed)]));
  const guiByKey = new Map();
  for (const row of gui) {
    const k = key(row.Fecha, row['Identificación'], row['#Comprobante'], money(row.Valor));
    if (!guiByKey.has(k)) guiByKey.set(k, []);
    guiByKey.get(k).push(row);
  }
  const accounts = await api.listV1('/api/v1/contabilidad/cuenta-contable/');
  const sourceAccountByCode = new Map(accounts.map((row) => [row.codigo, row.id]));
  const journals = [];
  for await (const page of api.pages('/api/v2/contabilidad/asiento/',
    { fecha_inicial: '30/09/2026', fecha_final: '30/09/2026' }, 100, {})) journals.push(...page.rows);
  const local = await Journal.find({ clinic: clinic._id,
    number: { $in: journals.map((row) => `CTF-${row.id}`) } }).select('number').lean();
  const localIds = new Set(local.map((row) => row.number.slice(4)));
  const matches = [];
  for (const row of live) {
    const person = personById.get(row.persona_id);
    const k = key(row.fecha_emision, person?.ruc || person?.cedula,
      row.numero_comprobante, row.total);
    const screens = guiByKey.get(k) || [];
    const candidates = screens.flatMap((screen) => journals.filter((journal) =>
      clean(journal.glosa) === clean(screen['Descripción']) &&
      journal.detalles?.some((line) => line.cuenta_id === sourceAccountByCode.get(screen['Código Cta Afectada']) &&
        line.tipo === 'D' && round(line.valor) === round(row.total))));
    const unique = [...new Set(candidates.map((entry) => entry.id))];
    matches.push({ id: row.id, total: round(row.total), guiCandidates: screens.length,
      journalCount: unique.length, journalId: unique.length === 1 ? unique[0] : null,
      sourceDocumentId: row.documento_id || row.detalles?.[0]?.documento_id || null,
      journalCandidates: unique.length > 1 ? unique : [],
      localJournal: unique.length === 1 && localIds.has(unique[0]),
      affectedAccounts: [...new Set(screens.map((screen) => screen['Código Cta Afectada']))] });
  }
  const summary = { sourceMissing: ids.size, liveFound: live.length,
    journalsRead: journals.length, uniqueJournalMatches: matches.filter((row) => row.journalCount === 1).length,
    zeroMatches: matches.filter((row) => row.journalCount === 0).length,
    ambiguous: matches.filter((row) => row.journalCount > 1).length,
    localJournalMatches: matches.filter((row) => row.localJournal).length,
    samples: matches.filter((row) => row.journalCount !== 1).slice(0, 20),
    matches: matches.filter((row) => row.journalCount === 1).slice(0, 10) };
  if (outputFile) fs.writeFileSync(outputFile, `${JSON.stringify({ ...summary, allMatches: matches }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
