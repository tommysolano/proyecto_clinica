#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Layer = require('../models/InventoryLayer');
const { decodeCompressedJson } = require('../utils/compressedJson');

const round4 = (value) => +Number(value || 0).toFixed(4);
const link = (record, model) => (record?.projection?.links || []).find((row) => row.model === model)?.ref || null;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [stocks, productRecords, warehouseRecords, layers, liveLayerStats] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'product_stock' })
      .select('_id externalId capturedAt payloadCompressed projection').lean(),
    Record.find({ clinic: clinic._id, entity: 'product' })
      .select('externalId projection.links').lean(),
    Record.find({ clinic: clinic._id, entity: 'warehouse' })
      .select('externalId projection.links').lean(),
    Layer.find({ clinic: clinic._id, sourceModel: 'ContificoStock' })
      .select('product warehouse qtyInitial qtyRemaining exhausted sourceRef date').lean(),
    Layer.aggregate([{ $match: { clinic: clinic._id } }, { $group: { _id: '$sourceModel',
      lines: { $sum: 1 }, positive: { $sum: { $cond: [{ $gt: ['$qtyRemaining', 0] }, 1, 0] } },
      negative: { $sum: { $cond: [{ $lt: ['$qtyRemaining', 0] }, 1, 0] } },
      zero: { $sum: { $cond: [{ $eq: ['$qtyRemaining', 0] }, 1, 0] } } } }]),
  ]);
  const products = new Map(productRecords.map((row) => [row.externalId, link(row, 'Product')]));
  const warehouses = new Map(warehouseRecords.map((row) => [row.externalId, link(row, 'Warehouse')]));
  const layerByKey = new Map(layers.map((row) => [`${row.product}|${row.warehouse}|${row.sourceRef}`, row]));
  const issues = [];
  const totals = { snapshots: stocks.length, warehouseLines: 0, positive: 0, zero: 0,
    negative: 0, negativeQuantity: 0, missingProduct: 0, missingWarehouse: 0,
    missingLayer: 0, differingLayer: 0, localLayers: layers.length };
  const expected = new Set();
  const samplePayload = stocks[0] && decodeCompressedJson(stocks[0].payloadCompressed);
  for (const record of stocks) {
    const payload = decodeCompressedJson(record.payloadCompressed);
    const product = products.get(String(payload.product_id || ''));
    for (const line of payload.stock || []) {
      totals.warehouseLines += 1;
      const quantity = round4(Number(line.cantidad || 0));
      if (quantity < 0) { totals.negative += 1; totals.negativeQuantity += quantity; }
      else if (quantity === 0) totals.zero += 1;
      else totals.positive += 1;
      const warehouse = warehouses.get(String(line.bodega_id || ''));
      if (!product) { totals.missingProduct += 1; continue; }
      if (!warehouse) { totals.missingWarehouse += 1; continue; }
      const key = `${product}|${warehouse}|${record._id}`;
      expected.add(key);
      const found = layerByKey.get(key);
      if (!found) { totals.missingLayer += 1;
        if (issues.length < 20) issues.push({ kind: 'MISSING', product: payload.product_id,
          warehouse: line.bodega_id, quantity }); continue; }
      if (round4(found.qtyRemaining) !== quantity || round4(found.qtyInitial) !== quantity) {
        totals.differingLayer += 1;
        if (issues.length < 20) issues.push({ kind: 'AMOUNT', product: payload.product_id,
          warehouse: line.bodega_id, expected: quantity,
          actual: round4(found.qtyRemaining) });
      }
    }
  }
  totals.extraLayers = layers.filter((row) => !expected.has(`${row.product}|${row.warehouse}|${row.sourceRef}`)).length;
  totals.negativeQuantity = round4(totals.negativeQuantity);
  const captured = stocks.map((row) => row.capturedAt).filter(Boolean).sort((a, b) => a - b);
  console.log(JSON.stringify({ ...totals, captureRange: {
    first: captured[0], last: captured[captured.length - 1] },
    liveLayerStats, sourceFields: {
      payload: Object.keys(samplePayload || {}),
      stockLine: Object.keys(samplePayload?.stock?.[0] || {}),
    }, issueSamples: issues }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
