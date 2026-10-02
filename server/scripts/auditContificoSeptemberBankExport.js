#!/usr/bin/env node
'use strict';
const fs = require('fs');

function parseTsv(input) {
  const records = [];
  let record = [], field = '', quoted = false, atFieldStart = true;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"' && quoted && input[index + 1] === '"') { field += '"'; index += 1; continue; }
    if (char === '"' && (quoted || atFieldStart)) { quoted = !quoted; atFieldStart = false; continue; }
    if (char === '\t' && !quoted) {
      record.push(field); field = ''; atFieldStart = true; continue;
    }
    if ((char === '\r' || char === '\n') && !quoted) {
      if (char === '\r' && input[index + 1] === '\n') index += 1;
      record.push(field);
      if (record.some((value) => value.trim())) records.push(record);
      record = []; field = ''; atFieldStart = true; continue;
    }
    field += char;
    atFieldStart = false;
  }
  if (quoted) throw new Error('El TSV termina dentro de un campo entre comillas');
  record.push(field);
  if (record.some((value) => value.trim())) records.push(record);
  return records;
}
function readRows(file) {
  const parsed = parseTsv(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const headers = parsed[0];
  return parsed.slice(1).map((values, index) => {
    if (values.length !== headers.length) throw new Error(`Registro ${index + 2}: ${values.length} columnas en vez de ${headers.length}`);
    return Object.fromEntries(headers.map((header, position) => [header, values[position].trim()]));
  });
}
const money = (value) => Number(String(value || '0').replace(/\./g, '').replace(',', '.')) || 0;
function main() {
const file = process.argv[2];
if (!file) throw new Error('Uso: node scripts/auditContificoSeptemberBankExport.js <archivo.tsv>');
const rows = readRows(file);
const headers = Object.keys(rows[0] || {});
const by = (field) => {
  const groups = new Map();
  for (const row of rows) {
    const key = row[field] || 'VACÍO';
    const entry = groups.get(key) || { value: key, count: 0, total: 0 };
    entry.count += 1;
    entry.total += money(row.Valor);
    groups.set(key, entry);
  }
  return [...groups.values()].map((entry) => ({ ...entry, total: +entry.total.toFixed(2) }))
    .sort((a, b) => b.count - a.count);
};
const vouchers = new Map();
for (const row of rows) {
  const key = [row.Fecha, row['Cuenta Bancaria'], row['Numero de comprobante'], row.Valor].join('|');
  vouchers.set(key, (vouchers.get(key) || 0) + 1);
}
console.log(JSON.stringify({ file, headerCount: headers.length, headers, rows: rows.length,
  byDate: by('Fecha'), byAccount: by('Cuenta Bancaria'), byType: by('Tipo'),
  byVoided: by('Anulado'), byAdvance: by('Anticipo'),
  totalUnsigned: +rows.reduce((sum, row) => sum + money(row.Valor), 0).toFixed(2),
  duplicateExactVoucherAmount: [...vouchers].filter(([, count]) => count > 1).slice(0, 20)
    .map(([key, count]) => ({ key, count })),
  withoutVoucher: rows.filter((row) => !row['Numero de comprobante']).length,
  examplesLast: rows.slice(-5) }, null, 2));
}
if (require.main === module) main();
module.exports = { readRows, money };
