#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Product = require('../models/Product');
const { decodeCompressedJson } = require('../utils/compressedJson');

const file = process.argv[2];
if (!file) throw new Error('Uso: node scripts/auditContificoVisibleProductCatalog.js <archivo de pantalla>');
const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const amount = (raw) => Number(String(raw || '0').trim().replace(/\./g, '').replace(',', '.'));
const money = (raw) => Math.round(Number(raw || 0) * 100) / 100;
const norm = (raw) => String(raw || '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('es-EC');
const report = [];
let category = '';
for (let i = 0; i < lines.length; i += 1) {
  if (lines[i + 1]?.startsWith('Código\tNombre\tUnidad\tStock\tPVP1')) {
    category = lines[i].trim();
    i += 1;
    continue;
  }
  const state = lines[i + 2]?.match(/^\s*(Activo|Inactivo)\s*·\s*(Simple|Compuesto)\s*$/i);
  const stock = lines[i + 3]?.match(/^([^\t]+)\t(-?[\d.,]+)\s*$/);
  if (!category || !state || !stock || !/^Min:\s*-?[\d.,]+$/.test(lines[i + 4] || '') ||
      !/^-?[\d.,]+$/.test(lines[i + 5] || '')) continue;
  const taxIndex = lines[i + 6]?.trim() === 'PVP Manual' ? i + 7 : i + 6;
  if (!/^\d+(?:[.,]\d+)?%/.test(lines[taxIndex] || '')) continue;
  report.push({ category, code: lines[i].trim(), name: lines[i + 1].trim(),
    active: state[1].toLowerCase() === 'activo', composite: state[2].toLowerCase() === 'compuesto',
    unit: stock[1].trim(), stock: amount(stock[2]), min: amount(lines[i + 4].replace('Min:', '')),
    price: amount(lines[i + 5]), tax: amount(lines[taxIndex].split('%')[0]),
    forSale: lines.slice(taxIndex + 1, taxIndex + 4).some((line) => line.trim() === 'Para Venta'),
    forPurchase: lines.slice(taxIndex + 1, taxIndex + 4).some((line) => line.trim() === 'Para Compra'),
    inventoriable: lines.slice(taxIndex + 1, taxIndex + 5).some((line) => line.trim() === 'Inventariable'),
  });
  i = taxIndex;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const codes = report.map((row) => row.code);
  const [records, categories, local] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'product' }).select('externalId capturedAt payloadCompressed projection').lean(),
    Record.find({ clinic: clinic._id, entity: 'category' }).select('externalId payloadCompressed').lean(),
    Product.find({ clinic: clinic._id, code: { $in: codes } }).select('code name categoria stock salePrice minStock active isComposite taxRate unit').lean(),
  ]);
  const cat = new Map(categories.map((r) => [r.externalId, decodeCompressedJson(r.payloadCompressed)?.nombre || '']));
  const source = new Map(records.map((r) => {
    const p = decodeCompressedJson(r.payloadCompressed);
    return [String(p.codigo || ''), { p, capturedAt: r.capturedAt, externalId: r.externalId,
      category: cat.get(String(p.categoria_id || '')) || '' }];
  }));
  const native = new Map(local.map((r) => [r.code, r]));
  const differences = [];
  const counts = { gui: report.length, categories: new Set(report.map((r) => r.category)).size,
    duplicateGuiCodes: report.length - new Set(codes).size, missingSource: 0, missingLocal: 0,
    sourceDifferences: 0, localDifferences: 0 };
  const byField = {};
  const categoryCounts = {};
  for (const row of report) {
    categoryCounts[row.category] = (categoryCounts[row.category] || 0) + 1;
    const archived = source.get(row.code), current = native.get(row.code);
    if (!archived) { counts.missingSource += 1; differences.push({ code: row.code, field: 'source', gui: row }); continue; }
    if (!current) { counts.missingLocal += 1; differences.push({ code: row.code, field: 'local', gui: row }); continue; }
    const p = archived.p;
    const expected = { name: p.nombre, category: archived.category, stock: Number(p.cantidad_stock || 0),
      price: Number(p.pvp1 || 0), min: Number(p.minimo || 0), active: String(p.estado || 'A') === 'A',
      composite: String(p.tipo_producto || '').toUpperCase() === 'COP', tax: Number(p.porcentaje_iva || 0) };
    const observed = { name: current.name, category: current.categoria, stock: Number(current.stock || 0),
      price: Number(current.salePrice || 0), min: Number(current.minStock || 0), active: !!current.active,
      composite: !!current.isComposite, tax: Number(current.taxRate || 0) };
    for (const field of Object.keys(expected)) {
      const guiValue = row[field], sourceValue = expected[field], localValue = observed[field];
      const equal = field === 'name' || field === 'category'
        ? (a, b) => norm(a) === norm(b)
        : field === 'stock' || field === 'price' || field === 'min' || field === 'tax'
          ? (a, b) => money(a) === money(b) : (a, b) => a === b;
      const srcDiff = !equal(guiValue, sourceValue), localDiff = !equal(guiValue, localValue);
      if (srcDiff) counts.sourceDifferences += 1;
      if (localDiff) counts.localDifferences += 1;
      if (srcDiff || localDiff) {
        byField[field] ||= { source: 0, local: 0 };
        if (srcDiff) byField[field].source += 1;
        if (localDiff) byField[field].local += 1;
        differences.push({ code: row.code, field, gui: guiValue, source: sourceValue, local: localValue,
          sourceId: archived.externalId, capturedAt: archived.capturedAt });
      }
    }
  }
  console.log(JSON.stringify({ counts, byField, categoryCounts, differences: differences.slice(0, 100),
    moreDifferences: Math.max(0, differences.length - 100) }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
