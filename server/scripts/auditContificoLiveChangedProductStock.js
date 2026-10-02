#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Product = require('../models/Product');
const Layer = require('../models/InventoryLayer');
const Warehouse = require('../models/Warehouse');
const { ContificoApi } = require('../services/contificoApi');

const input = process.argv[2];
if (!input) throw new Error('Uso: node scripts/auditContificoLiveChangedProductStock.js <ndjson de auditoría>');
const bytes = fs.readFileSync(input);
const content = bytes[0] === 0xFF && bytes[1] === 0xFE
  ? bytes.subarray(2).toString('utf16le') : bytes.toString('utf8').replace(/^\uFEFF/, '');
const prior = content.trim().split(/\r?\n/).map((line) => JSON.parse(line));
const selected = prior.filter((row) => row.live && Number(row.live.stock) !== Number(row.local?.stock));
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [products, warehouses] = await Promise.all([
    Product.find({ clinic: clinic._id, code: { $in: selected.map((r) => r.code) } }).select('_id code stock').lean(),
    Warehouse.find({ clinic: clinic._id }).select('_id code name').lean(),
  ]);
  const prodByCode = new Map(products.map((r) => [r.code, r]));
  const whByName = new Map(warehouses.map((r) => [String(r.name).trim().toUpperCase(), r]));
  const layers = await Layer.find({ clinic: clinic._id, sourceModel: 'ContificoStock',
    product: { $in: products.map((p) => p._id) } }).select('product warehouse qtyRemaining').lean();
  const localByKey = new Map(layers.map((r) => [`${r.product}|${r.warehouse}`, Number(r.qtyRemaining)]));
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 30000 });
  const results = [];
  async function inspect(row) {
    try {
      const source = await api.get(`/api/v2/producto/${row.id}/stock/`);
      const total = source.reduce((sum, line) => sum + Number(line.cantidad || 0), 0);
      const product = prodByCode.get(row.code);
      const lines = source.map((line) => {
        const warehouse = whByName.get(String(line.bodega_nombre || '').trim().toUpperCase());
        return { sourceWarehouse: line.bodega_nombre, sourceWarehouseId: line.bodega_id,
          sourceQty: Number(line.cantidad || 0), localQty: warehouse && product
            ? localByKey.get(`${product._id}|${warehouse._id}`) ?? null : null };
      });
      return { code: row.code, sourceGlobal: Number(row.live.stock), sourceWarehouseTotal: total,
        localGlobal: Number(row.local.stock), sourceLines: lines };
    } catch (error) { return { code: row.code, error: error.message }; }
  }
  for (let i = 0; i < selected.length; i += 4) {
    results.push(...await Promise.all(selected.slice(i, i + 4).map(inspect)));
    console.log(`PROGRESO ${Math.min(i + 4, selected.length)}/${selected.length}`);
  }
  const report = { checked: results.length, failures: results.filter((r) => r.error).length,
    globalVsBodega: results.filter((r) => !r.error && Math.abs(r.sourceGlobal - r.sourceWarehouseTotal) > 0.0001)
      .map((r) => ({ code: r.code, global: r.sourceGlobal, warehouseTotal: r.sourceWarehouseTotal })),
    differingWarehouseLines: results.flatMap((r) => (r.sourceLines || [])
      .filter((line) => line.localQty !== line.sourceQty).map((line) => ({ code: r.code, ...line }))),
    errors: results.filter((r) => r.error), results };
  const output = input.replace(/\.ndjson$/i, '-stock.json');
  fs.writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, checked: report.checked, failures: report.failures,
    globalVsBodega: report.globalVsBodega.length,
    differingWarehouseLines: report.differingWarehouseLines.length,
    sample: report.globalVsBodega.slice(0, 8), errors: report.errors }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
