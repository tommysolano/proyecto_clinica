#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Product = require('../models/Product');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { ContificoApi } = require('../services/contificoApi');

const codes = process.argv.slice(2);
if (!codes.length) throw new Error('Uso: node scripts/probeContificoVisibleProductChanges.js CODIGO...');
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const records = await Record.find({ clinic: clinic._id, entity: 'product' })
    .select('externalId payloadCompressed capturedAt').lean();
  const selected = records.map((r) => ({ record: r, payload: decodeCompressedJson(r.payloadCompressed) }))
    .filter(({ payload }) => codes.includes(String(payload.codigo || '')));
  const local = await Product.find({ clinic: clinic._id, code: { $in: codes } })
    .select('code name stock salePrice active').lean();
  const byCode = new Map(local.map((r) => [r.code, r]));
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 30000 });
  async function probe({ record, payload }) {
    try {
      const live = await api.get(`/api/v2/producto/${record.externalId}/`);
      return { code: payload.codigo, id: record.externalId, archivedAt: record.capturedAt,
        archived: { name: payload.nombre, stock: payload.cantidad_stock, price: payload.pvp1 },
        local: byCode.get(payload.codigo) && { name: byCode.get(payload.codigo).name,
          stock: byCode.get(payload.codigo).stock, price: byCode.get(payload.codigo).salePrice },
        live: { name: live.nombre, stock: live.cantidad_stock, price: live.pvp1, updated: live.fecha_modificacion || live.updated_at },
      };
    } catch (error) { return { code: payload.codigo, id: record.externalId, error: error.message }; }
  }
  for (let i = 0; i < selected.length; i += 4) {
    const results = await Promise.all(selected.slice(i, i + 4).map(probe));
    results.forEach((row) => console.log(JSON.stringify(row)));
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
