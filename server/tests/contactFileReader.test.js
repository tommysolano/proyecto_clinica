/**
 * Lectura de archivos de contactos: además de .xlsx y .csv (coma), debe tragar lo
 * que exporta Google Sheets sin dar error — CSV con PUNTO Y COMA (locales donde la
 * coma es el decimal), TSV (tabuladores) y BOM — y dar un mensaje claro con .ods.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const reader = require('../utils/contactFileReader');

function tmp(name, content) {
  const p = path.join(os.tmpdir(), `rd_${Date.now()}_${Math.random().toString(36).slice(2)}_${name}`);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

test('CSV con punto y coma (Google Sheets/Excel en español) + BOM: separa bien las columnas', async () => {
  const file = tmp('g.csv', '﻿Nombre;Telefono;Sucursal\nEmily;0999111222;Quito\nDome;0988776655;Guayaquil\n');
  const { headers } = await reader.readHeaders(file, 'g.csv');
  assert.deepEqual(headers, ['Nombre', 'Telefono', 'Sucursal']);
  const rows = [];
  await reader.iterateRows(file, 'g.csv', (o) => rows.push(o));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].Telefono, '0999111222');
  assert.equal(rows[0].Sucursal, 'Quito');
});

test('TSV (tabuladores, descarga de Google Sheets) se lee como tabla', async () => {
  const file = tmp('g.tsv', 'Nombre\tTelefono\tSucursal\nAna\t0991234567\tQuito\n');
  assert.equal(reader.isSupported('g.tsv'), true);
  const { headers } = await reader.readHeaders(file, 'g.tsv');
  assert.deepEqual(headers, ['Nombre', 'Telefono', 'Sucursal']);
  const rows = [];
  await reader.iterateRows(file, 'g.tsv', (o) => rows.push(o));
  assert.equal(rows[0].Telefono, '0991234567');
});

test('CSV normal (coma) sigue funcionando', async () => {
  const file = tmp('c.csv', 'Nombre,Telefono\nAna,0991234567\n');
  const { headers } = await reader.readHeaders(file, 'c.csv');
  assert.deepEqual(headers, ['Nombre', 'Telefono']);
  const rows = [];
  await reader.iterateRows(file, 'c.csv', (o) => rows.push(o));
  assert.equal(rows[0].Telefono, '0991234567');
});

test('.ods da un mensaje claro (no un error críptico)', async () => {
  await assert.rejects(
    () => reader.readHeaders('x.ods', 'x.ods'),
    /ods.*no se admiten|Microsoft Excel|\.csv/i
  );
});

test('formatCellDate: una celda-fecha se muestra legible (hora sola → HH:MM), no como ISO', () => {
  // Ancla de Excel (1899): la celda es SOLO una hora del día.
  assert.equal(reader.formatCellDate(new Date(Date.UTC(1899, 11, 31, 8, 0, 0))), '08:00');
  assert.equal(reader.formatCellDate(new Date(Date.UTC(1899, 11, 30, 14, 30, 0))), '14:30');
  // Fecha real → YYYY-MM-DD; con hora → añade HH:MM.
  assert.equal(reader.formatCellDate(new Date(Date.UTC(2026, 6, 22, 0, 0, 0))), '2026-07-22');
  assert.equal(reader.formatCellDate(new Date(Date.UTC(2026, 6, 22, 14, 30, 0))), '2026-07-22 14:30');
});

test('XLSX con celda de HORA: end-to-end queda en "HH:MM" (adiós a los "demasiados decimales")', async () => {
  // Reproduce el bug real: Excel guarda "08:00" como una fracción de día y el lector
  // en STREAMING de ExcelJS la entrega como número crudo (1,3333…). Da igual cómo
  // llegue: al mapearla a la Hora de envío, parseSendTime la deja en "08:00".
  const ExcelJS = require('exceljs');
  const { parseSendTime } = require('../utils/contactRowMapper');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('C');
  ws.addRow(['Nombre', 'Telefono', 'Hora']);
  const r1 = ws.addRow(['Ana', '0999111222', new Date(Date.UTC(1899, 11, 31, 8, 0, 0))]);
  r1.getCell(3).numFmt = 'hh:mm';
  const r2 = ws.addRow(['Beto', '0988776655', new Date(Date.UTC(1899, 11, 31, 14, 30, 0))]);
  r2.getCell(3).numFmt = 'hh:mm';
  const file = path.join(os.tmpdir(), `hora_${Date.now()}_${Math.random().toString(36).slice(2)}.xlsx`);
  await wb.xlsx.writeFile(file);

  const rows = [];
  await reader.iterateRows(file, 'hora.xlsx', (o) => rows.push(o));
  assert.equal(parseSendTime(rows[0].Hora), '08:00', `de "${rows[0].Hora}" → 08:00`);
  assert.equal(parseSendTime(rows[1].Hora), '14:30', `de "${rows[1].Hora}" → 14:30`);
  fs.unlinkSync(file);
});
