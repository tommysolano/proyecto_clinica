#!/usr/bin/env node
'use strict';
// Uso: node scripts/syncContificoCostCenters.js [--commit] [--months=2026-09,2026-10]
// Recalcula el centro de costo de compras, CxP, CxC, facturas y cobros/pagos de Contífico
// (ver services/contificoCostCenters). Sin --commit solo informa; sin --months
// recorre desde noviembre de 2025 hasta el mes actual.
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const { refreshCostCenters } = require('../services/contificoCostCenters');
const { ecToday } = require('../services/contificoFinancialSync');

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const commit = process.argv.includes('--commit');
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
