#!/usr/bin/env node
'use strict';

// Compara el texto copiado de la pantalla local de Personas con MongoDB y la API archivada.
// Uso: node scripts/auditContificoSupplierPage.js --input="ruta/Pasted text.txt"
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Supplier = require('../models/Supplier');
const ContificoRecord = require('../models/ContificoRecord');
const { decodeCompressedJson } = require('../utils/compressedJson');

const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
const clean = (value) => String(value || '').trim().replace(/\s+/g, ' ');
const roleNames = new Map([['Cliente', 'CLIENTE'], ['Proveedor', 'PROVEEDOR'], ['Empleado', 'EMPLEADO'], ['Vendedor', 'VENDEDOR']]);

function parsePasted(text) {
  const rows = [];
  let current;
  for (const raw of text.split(/\r?\n/)) {
    const match = raw.match(/^(\d{8,13})\t(\S.*)$/);
    if (match) {
      current = { id: match[1], name: clean(match[2]), cells: [] };
      rows.push(current);
    } else if (current && clean(raw)) current.cells.push(clean(raw));
  }
  return rows.map(({ id, name, cells }) => ({
    id, name,
    commercial: roleNames.has(cells[0]) ? '' : (cells[0] || ''),
    roles: cells.filter((cell) => roleNames.has(cell)).map((cell) => roleNames.get(cell)).sort(),
  }));
}

async function main() {
  if (!input) throw new Error('Falta --input=archivo de la pantalla local');
  const pasted = parsePasted(fs.readFileSync(input, 'utf8'));
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const [suppliers, sourceRows] = await Promise.all([
    Supplier.find({ clinic: clinic._id }).select('ruc razonSocial nombreComercial roles active').lean(),
    ContificoRecord.find({ clinic: clinic._id, entity: 'person' }).select('externalId payloadCompressed').lean(),
  ]);
  const localById = new Map(suppliers.map((row) => [String(row.ruc), row]));
  const screenById = new Map(pasted.map((row) => [row.id, row]));
  const sourceProviders = new Map();
  for (const record of sourceRows) {
    const row = decodeCompressedJson(record.payloadCompressed);
    if (row.es_proveedor) sourceProviders.set(String(row.ruc || row.cedula || ''), { record, row });
  }
  const screenDifferences = [], sourceDifferences = [];
  for (const screen of pasted) {
    const local = localById.get(screen.id);
    if (!local) { screenDifferences.push({ id: screen.id, kind: 'SCREEN_ONLY' }); continue; }
    if (screen.name !== clean(local.razonSocial)) screenDifferences.push({ id: screen.id, kind: 'NAME', screen: screen.name, local: clean(local.razonSocial) });
    if (screen.commercial !== clean(local.nombreComercial)) screenDifferences.push({ id: screen.id, kind: 'COMMERCIAL', screen: screen.commercial, local: clean(local.nombreComercial) });
    if (JSON.stringify(screen.roles) !== JSON.stringify([...(local.roles || [])].sort())) {
      screenDifferences.push({ id: screen.id, kind: 'ROLES', screen: screen.roles, local: local.roles });
    }
  }
  for (const [id, row] of localById) if (!screenById.has(id)) screenDifferences.push({ id, kind: 'LOCAL_ONLY' });
  for (const [id, { row }] of sourceProviders) {
    const local = localById.get(id), screen = screenById.get(id);
    if (!local || !screen) { sourceDifferences.push({ id, kind: !local ? 'LOCAL_MISSING' : 'SCREEN_MISSING' }); continue; }
    if (clean(row.razon_social || row.nombre_comercial || id) !== clean(local.razonSocial)) sourceDifferences.push({ id, kind: 'SOURCE_NAME' });
    if (clean(row.nombre_comercial) !== clean(local.nombreComercial)) sourceDifferences.push({ id, kind: 'SOURCE_COMMERCIAL' });
    if (!local.roles?.includes('PROVEEDOR')) sourceDifferences.push({ id, kind: 'SOURCE_PROVIDER_ROLE_MISSING' });
  }
  const historical = suppliers.filter((local) => local.roles?.includes('PROVEEDOR') && !sourceProviders.has(String(local.ruc)));
  const report = {
    screenRows: pasted.length, screenUniqueIds: screenById.size, localRows: suppliers.length,
    screenProviderRoles: pasted.filter((row) => row.roles.includes('PROVEEDOR')).length,
    localProviderRoles: suppliers.filter((row) => row.roles?.includes('PROVEEDOR')).length,
    currentSourceProviders: sourceProviders.size,
    historicalLocalProviders: historical.map((row) => ({ id: row.ruc, active: row.active })),
    screenDifferences: screenDifferences.length, screenDifferenceSamples: screenDifferences.slice(0, 30),
    currentSourceDifferences: sourceDifferences.length, sourceDifferenceSamples: sourceDifferences.slice(0, 30),
  };
  console.log(JSON.stringify(report, null, 2));
  if (screenDifferences.length || sourceDifferences.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
