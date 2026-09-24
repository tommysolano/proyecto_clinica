#!/usr/bin/env node
'use strict';

/**
 * Audita EN VIVO el mayor propio contra los asientos de Contífico.
 *
 * Descarga los asientos del rango con la paginación sin pérdida, los agrupa por
 * código de cuenta y los enfrenta a los JournalEntry locales. Informa, cuenta a
 * cuenta, la diferencia, y lista los asientos que solo están en un lado con su
 * fecha, glosa e importe, para poder explicar cada centavo.
 *
 * Es de solo lectura: no escribe en Mongo ni en Contífico.
 *
 *   node scripts/auditContificoLedger.js --clinic-name=Central
 *   node scripts/auditContificoLedger.js --clinic-name=Central --from=01/01/2026 --through=31/12/2026
 *   node scripts/auditContificoLedger.js --clinic-name=Central --detail=20
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const { ContificoApi } = require('../services/contificoApi');
const { parseDate, fmt, months } = require('./migrateContifico');

const num = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const r2 = (value) => +num(value).toFixed(2);
const pad = (value, width) => String(value).padEnd(width);
const money = (value) => r2(value).toFixed(2).padStart(14);

function args(argv) {
  const values = {}, flags = new Set();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const at = arg.indexOf('=');
    if (at < 0) flags.add(arg.slice(2)); else values[arg.slice(2, at)] = arg.slice(at + 1);
  }
  const year = new Date().getFullYear();
  return {
    clinicId: values.clinic || null,
    clinicName: values['clinic-name'] || 'Central',
    from: parseDate(values.from) || parseDate(`01/01/${year}`),
    through: parseDate(values.through) || parseDate(`31/12/${year}`),
    detail: Number(values.detail) > 0 ? Number(values.detail) : 40,
    all: flags.has('all'),
  };
}

/** Descarga los asientos del rango mes a mes, sin perder filas. */
async function fetchJournals(api, from, through, pageSize = 100) {
  const rows = new Map();
  const gaps = [];
  for (const month of months(from, through)) {
    const stats = {};
    for await (const page of api.pages(
      '/api/v2/contabilidad/asiento/',
      { fecha_inicial: fmt(month.from), fecha_final: fmt(month.through) },
      pageSize,
      stats,
    )) for (const row of page.rows) rows.set(String(row.id), row);
    if (stats.expected !== null && !stats.complete) {
      gaps.push(`${month.key}: Contífico informó ${stats.expected} y entregó ${stats.unique}`);
    }
  }
  return { rows, gaps };
}

async function main() {
  const options = args(process.argv.slice(2));
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  if (!process.env.CONTIFICO_API_KEY) throw new Error('Falta CONTIFICO_API_KEY');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = options.clinicId
    ? await Clinic.findById(options.clinicId).lean()
    : await Clinic.findOne({ name: new RegExp(`^${String(options.clinicName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).lean();
  if (!clinic) throw new Error('Clínica destino no encontrada');
  console.log(`Clínica: ${clinic.name} (${clinic._id})`);
  console.log(`Rango:   ${fmt(options.from)} - ${fmt(options.through)}\n`);

  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY });
  const sourceAccounts = await api.listV1('/api/v1/contabilidad/cuenta-contable/');
  const codeBySourceId = new Map(sourceAccounts.map((account) => [String(account.id), String(account.codigo)]));
  const nameByCode = new Map(sourceAccounts.map((account) => [String(account.codigo), String(account.nombre || '')]));
  const { rows: sourceRows, gaps } = await fetchJournals(api, options.from, options.through);
  console.log(`Asientos en Contífico: ${sourceRows.size}${gaps.length ? ` (ventanas incompletas: ${gaps.join('; ')})` : ''}`);

  const accounts = await ChartOfAccount.find({ clinic: clinic._id }).select('code name nature').lean();
  const accountById = new Map(accounts.map((account) => [String(account._id), account]));
  const natureByCode = new Map(accounts.map((account) => [String(account.code), account.nature]));
  accounts.forEach((account) => { if (!nameByCode.has(String(account.code))) nameByCode.set(String(account.code), account.name); });

  const start = new Date(Date.UTC(options.from.getUTCFullYear(), options.from.getUTCMonth(), options.from.getUTCDate(), 0, 0, 0));
  const end = new Date(Date.UTC(options.through.getUTCFullYear(), options.through.getUTCMonth(), options.through.getUTCDate(), 23, 59, 59, 999));
  const localEntries = await JournalEntry.find({ clinic: clinic._id, status: 'CONTABILIZADO', date: { $gte: start, $lte: end } })
    .select('number date description lines').lean();
  console.log(`Asientos en el sistema: ${localEntries.length}\n`);

  // Saldo por código de cuenta en cada lado. El signo lo fija la naturaleza de
  // la cuenta local, para que la cifra se lea igual que en los reportes.
  const sign = (code) => natureByCode.get(code) === 'CREDITO' ? -1 : 1;
  const source = new Map(), local = new Map();
  const add = (map, code, debit, credit) => {
    if (!map.has(code)) map.set(code, { debit: 0, credit: 0 });
    const row = map.get(code);
    row.debit += debit; row.credit += credit;
  };
  for (const row of sourceRows.values()) for (const detail of row.detalles || []) {
    const code = codeBySourceId.get(String(detail.cuenta_id)) || `?${detail.cuenta_id}`;
    const value = Math.max(0, num(detail.valor));
    add(source, code, String(detail.tipo).toUpperCase() === 'D' ? value : 0, String(detail.tipo).toUpperCase() === 'H' ? value : 0);
  }
  for (const entry of localEntries) for (const line of entry.lines || []) {
    const code = accountById.get(String(line.account))?.code || line.accountCode || '?';
    add(local, String(code), num(line.debit), num(line.credit));
  }

  const codes = [...new Set([...source.keys(), ...local.keys()])].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  console.log('CÓDIGO         CUENTA                                        CONTÍFICO        SISTEMA     DIFERENCIA');
  let differing = 0, worst = 0;
  for (const code of codes) {
    const s = source.get(code) || { debit: 0, credit: 0 }, l = local.get(code) || { debit: 0, credit: 0 };
    const sourceBalance = r2(sign(code) * (s.debit - s.credit)), localBalance = r2(sign(code) * (l.debit - l.credit));
    const delta = r2(sourceBalance - localBalance);
    if (!options.all && Math.abs(delta) < 0.005) continue;
    differing += 1; worst = Math.max(worst, Math.abs(delta));
    console.log(`${pad(code, 14)} ${pad((nameByCode.get(code) || '').slice(0, 40), 40)} ${money(sourceBalance)} ${money(localBalance)} ${money(delta)}`);
  }
  console.log(`\nCuentas con diferencia: ${differing} de ${codes.length} (mayor desvío ${worst.toFixed(2)})`);

  // El detalle es lo que permite explicar la diferencia sin abrir Contífico.
  const localByNumber = new Map(localEntries.map((entry) => [String(entry.number).replace(/^CTF-/, ''), entry]));
  const onlySource = [...sourceRows.keys()].filter((id) => !localByNumber.has(id));
  const onlyLocal = [...localByNumber.keys()].filter((id) => !sourceRows.has(id));
  const describe = (row) => (row.detalles || [])
    .map((detail) => `${codeBySourceId.get(String(detail.cuenta_id)) || '?'}:${String(detail.tipo).toUpperCase()}${r2(detail.valor)}`).join(' ');

  console.log(`\nSolo en Contífico (falta importar): ${onlySource.length}`);
  for (const id of onlySource.slice(0, options.detail)) {
    const row = sourceRows.get(id);
    console.log(`  ${id} ${row.fecha} ${pad(String(row.glosa || '').replace(/\s+/g, ' ').slice(0, 46), 48)} ${describe(row)}`);
  }
  if (onlySource.length > options.detail) console.log(`  ... y ${onlySource.length - options.detail} más (--detail=N para ver más)`);

  console.log(`\nSolo en el sistema (ya no está en Contífico): ${onlyLocal.length}`);
  for (const id of onlyLocal.slice(0, options.detail)) {
    const entry = localByNumber.get(id);
    const lines = (entry.lines || []).map((line) => `${line.accountCode}:${line.debit ? `D${r2(line.debit)}` : `H${r2(line.credit)}`}`).join(' ');
    console.log(`  ${id} ${fmt(entry.date)} ${pad(String(entry.description || '').replace(/\s+/g, ' ').slice(0, 46), 48)} ${lines}`);
  }
  if (onlyLocal.length > options.detail) console.log(`  ... y ${onlyLocal.length - options.detail} más (--detail=N para ver más)`);
}

if (require.main === module) {
  main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));
}

module.exports = { args, fetchJournals };
