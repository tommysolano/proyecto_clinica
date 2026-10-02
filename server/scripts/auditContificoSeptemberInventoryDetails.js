#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Movement = require('../models/InventoryMovement');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { parseDate } = require('./migrateContifico');

const round = (value) => +Number(value || 0).toFixed(2);
const iso = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;
const link = (record, model) => (record?.projection?.links || []).find((row) => row.model === model)?.ref || null;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const source = await Record.find({ clinic: clinic._id, entity: 'inventory_movement',
    'search.date': { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
    .select('_id externalId payloadCompressed projection').lean();
  const sourceRefs = source.map((row) => row._id);
  const [products, warehouses, local] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'product' }).select('externalId projection.links').lean(),
    Record.find({ clinic: clinic._id, entity: 'warehouse' }).select('externalId projection.links').lean(),
    Movement.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: sourceRefs } })
      .select('sourceRef reference movementDate type product warehouse toWarehouse quantity unitCost totalCost').lean(),
  ]);
  const productById = new Map(products.map((row) => [row.externalId, link(row, 'Product')]));
  const warehouseById = new Map(warehouses.map((row) => [row.externalId, link(row, 'Warehouse')]));
  const localByKey = new Map(local.map((row) => [`${row.sourceRef}|${row.reference}`, row]));
  const expectedKeys = new Set(), differences = [];
  let expected = 0, unsupportedLines = 0;
  for (const record of source) {
    const row = decodeCompressedJson(record.payloadCompressed);
    const from = warehouseById.get(String(row.bodega_id || ''));
    const to = warehouseById.get(String(row.bodega_destino_id || ''));
    for (const [index, detail] of (row.detalles || []).entries()) {
      const product = productById.get(String(detail.producto_id || ''));
      const quantity = Math.abs(Number(detail.cantidad || 0));
      if (!product || quantity <= 0) { unsupportedLines += 1; continue; }
      const unitCost = Math.max(0, Number(detail.costo_promedio || detail.precio || 0));
      const base = { date: iso(parseDate(row.fecha)), product: String(product), quantity: round(quantity),
        unitCost: round(unitCost), totalCost: round(quantity * unitCost) };
      const transfer = String(row.tipo).toUpperCase() === 'TRA';
      const variants = transfer ? [
        { suffix: ':OUT', type: 'salida', warehouse: from, toWarehouse: to },
        { suffix: ':IN', type: 'entrada', warehouse: to, toWarehouse: from },
      ] : [{ suffix: '', type: String(row.tipo).toUpperCase() === 'ING' ? 'entrada' :
        String(row.tipo).toUpperCase() === 'EGR' ? 'salida' : 'ajuste', warehouse: from }];
      for (const variant of variants) {
        expected += 1;
        const reference = `${row.codigo}:${index}${variant.suffix}`;
        const k = `${record._id}|${reference}`;
        expectedKeys.add(k);
        const found = localByKey.get(k);
        if (!found) { if (differences.length < 30) differences.push({ id: record.externalId, reference, kind: 'MISSING' }); continue; }
        const actual = { date: iso(found.movementDate), product: String(found.product),
          quantity: round(found.quantity), unitCost: round(found.unitCost), totalCost: round(found.totalCost) };
        if (JSON.stringify(base) !== JSON.stringify(actual) || found.type !== variant.type ||
          String(found.warehouse || '') !== String(variant.warehouse || '') ||
          String(found.toWarehouse || '') !== String(variant.toWarehouse || ''))
          if (differences.length < 30) differences.push({ id: record.externalId, reference,
            kind: 'FIELDS', expected: { ...base, ...variant }, actual: { ...actual,
              type: found.type, warehouse: String(found.warehouse || ''), toWarehouse: String(found.toWarehouse || '') } });
      }
    }
  }
  const extra = local.filter((row) => !expectedKeys.has(`${row.sourceRef}|${row.reference}`));
  console.log(JSON.stringify({ archivedMovements: source.length, expectedLines: expected,
    localLines: local.length, unsupportedLines, differences: differences.length,
    differenceSamples: differences, extraLines: extra.length,
    extraSamples: extra.slice(0, 15).map((row) => ({ sourceRef: String(row.sourceRef), reference: row.reference })) }, null, 2));
  if (differences.length || extra.length || unsupportedLines) process.exitCode = 2;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
