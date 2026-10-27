#!/usr/bin/env node
'use strict';
// Uso: node scripts/syncContificoCostCenters.js [--commit] [--months=2026-09,2026-10]
// Recalcula el centro de costo de compras, CxP, CxC, facturas y cobros/pagos de Contífico
// respetando los documentos que llegan sin centro desde la fuente.
// (ver services/contificoCostCenters). Sin --commit solo informa; sin --months
// recorre desde noviembre de 2025 hasta el mes actual.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { EJSON } = mongoose.mongo.BSON;
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payable = require('../models/Payable');
const Receivable = require('../models/Receivable');
const Invoice = require('../models/Invoice');
const Payment = require('../models/Payment');
const { refreshCostCenters } = require('../services/contificoCostCenters');
const { ecToday } = require('../services/contificoFinancialSync');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await require('../services/contificoSourceClinic').contificoSourceClinic();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const commit = process.argv.includes('--commit');
  if (commit) {
    const rows = {};
    for (const [name, Model, fields] of [
      ['purchases', PurchaseInvoice, '_id costCenter items._id items.costCenter'],
      ['payables', Payable, '_id costCenter'], ['receivables', Receivable, '_id costCenter'],
      ['invoices', Invoice, '_id costCenter'], ['payments', Payment, '_id costCenter'],
    ]) rows[name] = await Model.find({ clinic: clinic._id }).select(fields).lean();
    const folder = path.resolve(__dirname, '..', 'storage', 'branch-centers');
    fs.mkdirSync(folder, { recursive: true });
    const backup = path.join(folder, `before-source-centers-${new Date().toISOString().replace(/[:.]/g, '-')}.json.gz`);
    fs.writeFileSync(backup, zlib.gzipSync(Buffer.from(EJSON.stringify({ clinic: clinic._id, rows },
      { relaxed: false }))), { flag: 'wx' });
    console.log(`Copia previa: ${backup}`);
  }
  const monthArg = process.argv.find((arg) => arg.startsWith('--months='));
  let months = monthArg ? monthArg.slice('--months='.length).split(',').map((value) => value.trim()) : null;
  if (!months) {
    const today = ecToday();
    months = [];
    for (let year = 2025, month = 11; year < today.year || (year === today.year && month <= today.month);) {
      months.push(`${year}-${String(month).padStart(2, '0')}`);
      month += 1;
      if (month > 12) { month = 1; year += 1; }
    }
  }
  console.log(`MODO ${commit ? 'COMMIT' : 'DRY_RUN'}`);
  for (const value of months) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error(`Mes inválido ${value}`);
    const [year, month] = value.split('-').map(Number);
    const result = await refreshCostCenters({ clinicId: clinic._id, commit,
      from: new Date(Date.UTC(year, month - 1, 1)), to: new Date(Date.UTC(year, month, 1) - 1) });
    console.log(value, JSON.stringify(result));
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
