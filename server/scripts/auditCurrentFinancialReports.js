#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const reports = require('../controllers/accountingReportsController');

async function call(handler, clinicId, query) {
  let code = 200, body;
  const response = { status(value) { code = value; return this; }, json(value) { body = value; return this; } };
  await handler({ clinicId, query }, response);
  if (code !== 200) throw new Error(`${code} ${JSON.stringify(body)}`);
  return body;
}
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const [income, balance] = await Promise.all([
    call(reports.incomeStatement, clinic._id, { startDate: '2026-01-01', endDate: '2026-12-31' }),
    call(reports.balanceSheet, clinic._id, { date: '2026-12-31' }),
  ]);
  const accounts = {};
  for (const row of [...balance.activos, ...balance.pasivos, ...balance.patrimonio])
    if (['1.1.1.1', '1.1.1.3', '1.1.2.5.7', '1.1.3.6', '2.1.3.1.1'].includes(row.code))
      accounts[row.code] = row.balance;
  console.log(JSON.stringify({ income: { totalIngresos: income.totalIngresos,
    totalCostos: income.totalCostos, totalGastos: income.totalGastos,
    utilidadOperacional: income.utilidadOperacional, utilidadNetaEstimada: income.utilidadNeta },
  balance: { totalActivos: balance.totalActivos, totalPasivos: balance.totalPasivos,
    totalPatrimonio: balance.totalPatrimonio, utilidadEjercicio: balance.utilidadEjercicio,
    descuadre: balance.descuadre, accounts } }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
