#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Product = require('../models/Product');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { ContificoApi } = require('../services/contificoApi');

const [code, file] = process.argv.slice(2);
if (!code || !file) throw new Error('Uso: node scripts/syncContificoVisibleProductName.js CODIGO archivo [--commit]');
const commit = process.argv.includes('--commit');
const lines = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
const index = lines.findIndex((line, i) => line.trim() === code &&
  /^\s*(Activo|Inactivo)\s*·\s*(Simple|Compuesto)\s*$/i.test(lines[i + 2] || ''));
if (index < 0) throw new Error(`Código ${code} ausente del catálogo visible`);
const guiName = lines[index + 1].trim();
const norm = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('es-EC');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [records, product] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'product' }).select('externalId payloadCompressed').lean(),
    Product.findOne({ clinic: clinic._id, code }).lean(),
  ]);
  const record = records.find((row) => decodeCompressedJson(row.payloadCompressed)?.codigo === code);
  if (!record || !product) throw new Error('Código sin registro fuente o producto local');
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 30000 });
  const live = await api.get(`/api/v2/producto/${record.externalId}/`);
  if (String(live.id) !== String(record.externalId) || String(live.codigo) !== code || norm(live.nombre) !== norm(guiName))
    throw new Error('La ficha actual de Contífico no coincide con el código y nombre del archivo visible');
  const summary = { code, sourceId: record.externalId, guiName, liveName: live.nombre,
    localBefore: product.name, localAfter: live.nombre, commit };
  if (!commit || product.name === live.nombre) { console.log(JSON.stringify(summary, null, 2)); return; }
  const dir = path.join(__dirname, '..', 'storage', 'contifico-batches');
  fs.mkdirSync(dir, { recursive: true });
  const backup = path.join(dir, `product-name-${code}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.writeFileSync(backup, JSON.stringify({ ...summary, sourcePayload: live,
    localBefore: product, capturedAt: new Date().toISOString() }, null, 2));
  const result = await Product.updateOne({ _id: product._id, clinic: clinic._id, name: product.name },
    { $set: { name: live.nombre } });
  if (result.modifiedCount !== 1) throw new Error(`Actualización concurrente del producto; respaldo ${backup}`);
  console.log(JSON.stringify({ ...summary, backup, modifiedCount: result.modifiedCount }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
