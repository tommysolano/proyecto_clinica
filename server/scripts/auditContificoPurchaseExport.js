#!/usr/bin/env node
'use strict';

// Compara el exporte visible de Transacciones de Contífico contra su API viva
// y las compras locales. Lee el archivo completo, pero solo coteja Proveedor.
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { parse } = require('csv-parse/sync');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const { ContificoApi } = require('../services/contificoApi');
const { parseDate } = require('./migrateContifico');

const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
const money = (value) => +Number(String(value || '0').replace(/\./g, '').replace(',', '.')).toFixed(2);
const round = (value) => +Number(value || 0).toFixed(2);
const day = (value) => {
  const raw = String(value || '');
  const normalized = /^\d{2}\/\d{2}\/\d{2}$/.test(raw) ? `${raw.slice(0, 6)}20${raw.slice(6)}` : raw;
  return parseDate(normalized)?.toISOString().slice(0, 10) || '';
};
const key = (date, number, auth, person) => [date, number, auth, person].join('|');

async function main() {
  if (!input) throw new Error('Falta --input=archivo exportado');
  const rows = parse(fs.readFileSync(input, 'utf8'), { delimiter: '\t', columns: true,
    relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
  const idColumn = Object.keys(rows[0])[9];
  const gui = rows.filter((row) => row['Tipo Registro'] === 'Proveedor');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY,
    retries: 2, timeoutMs: 20000 });
  const pagination = {};
  const live = [];
  for await (const page of api.pages('/api/v2/documento/', {
    tipo_registro: 'PRO', fecha_inicial: '01/09/2026', fecha_final: '30/09/2026',
  }, 100, pagination)) live.push(...page.rows);
  const sourceIds = live.map((row) => row.id);
  const [records, local] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'document', externalId: { $in: sourceIds } })
      .select('_id externalId').lean(),
    Purchase.find({ clinic: clinic._id, sourceModel: 'ContificoRecord',
      fechaEmision: { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
      .select('sourceRef total iva balance status').lean(),
  ]);
  const refById = new Map(records.map((row) => [row.externalId, String(row._id)]));
  const localByRef = new Map(local.map((row) => [String(row.sourceRef), row]));
  const screenByKey = new Map();
  for (const row of gui) {
    const k = key(day(row.Fecha), row['# Documento'], row['Autorización'], row[idColumn]);
    const list = screenByKey.get(k) || [];
    list.push(row);
    screenByKey.set(k, list);
  }
  const guiDifferences = [], localDifferences = [], screenSeen = new Set();
  let matchedLocal = 0;
  for (const source of live) {
    const k = key(day(source.fecha_emision), source.documento, source.autorizacion,
      source.persona?.ruc || source.persona?.cedula || '');
    const candidates = screenByKey.get(k) || [];
    const screen = candidates.find((row) => !screenSeen.has(row));
    if (!screen) guiDifferences.push({ id: source.id, kind: 'GUI_MISSING', number: source.documento });
    else {
      screenSeen.add(screen);
      const expected = { total: round(source.total), iva: round(source.iva), balance: round(source.saldo) };
      const actual = { total: money(screen.Total), iva: money(screen.IVA), balance: money(screen.Saldo) };
      if (JSON.stringify(expected) !== JSON.stringify(actual))
        guiDifferences.push({ id: source.id, kind: 'GUI_FIELDS', number: source.documento, expected, actual });
    }
    const ref = refById.get(String(source.id));
    const localDoc = ref && localByRef.get(ref);
    if (!localDoc) {
      localDifferences.push({ id: source.id, kind: 'LOCAL_MISSING', docType: source.tipo_documento, number: source.documento,
        date: day(source.fecha_emision), total: round(source.total), balance: round(source.saldo) });
      continue;
    }
    const expected = { total: round(source.total), iva: round(source.iva), balance: Math.max(0, round(source.saldo)) };
    const actual = { total: round(localDoc.total), iva: round(localDoc.iva), balance: round(localDoc.balance) };
    if (JSON.stringify(expected) !== JSON.stringify(actual))
      localDifferences.push({ id: source.id, kind: 'LOCAL_FIELDS', number: source.documento,
        date: day(source.fecha_emision), expected, actual, localStatus: localDoc.status });
    else matchedLocal += 1;
  }
  for (const row of gui) if (!screenSeen.has(row))
    guiDifferences.push({ kind: 'API_MISSING', number: row['# Documento'], date: day(row.Fecha) });
  const report = { guiRows: gui.length, apiExpected: pagination.expected, apiUnique: pagination.unique,
    apiComplete: pagination.complete, apiRows: live.length, matchedLocal,
    advances: live.filter((row) => row.tipo_documento === 'DAC').map((row) => ({
      id: row.id, number: row.documento, date: day(row.fecha_emision), total: round(row.total),
      balance: round(row.saldo), localPurchase: Boolean(localByRef.get(refById.get(String(row.id)))),
    })),
    guiDifferences: guiDifferences.length, guiDifferenceSamples: guiDifferences.slice(0, 30),
    localDifferences: localDifferences.length, localDifferenceRows: localDifferences,
    requests: api.metrics.requests };
  console.log(JSON.stringify(report, null, 2));
  if (!pagination.complete || guiDifferences.length || localDifferences.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
