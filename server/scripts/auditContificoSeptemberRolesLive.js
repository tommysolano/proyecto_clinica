#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Employee = require('../models/Employee');
const { ContificoApi } = require('../services/contificoApi');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const employees = await Employee.find({ clinic: clinic._id }).select('identificacion').lean();
  const ids = [...new Set(employees.map((row) => String(row.identificacion || '')).filter(Boolean))];
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const requests = ids.flatMap((cedula) => ['P', 'S', 'M'].map((periodo) => ({ cedula, periodo })));
  const results = [];
  for (let i = 0; i < requests.length; i += 4) {
    const batch = await Promise.all(requests.slice(i, i + 4).map(async (request) => ({ ...request,
      rows: await api.listV1('/api/v1/rrhh/rol-pago/',
        { cedula: request.cedula, periodo: request.periodo, anio: 2026, mes: 9 },
        { singleObject: true }),
    })));
    results.push(...batch);
    console.log(`[roles-septiembre] consultas ${results.length}/${requests.length}; roles ${results.reduce((sum, row) => sum + row.rows.length, 0)}`);
  }
  const roles = results.flatMap((result) => result.rows.map((row) => ({
    cedula: result.cedula, periodo: result.periodo, comprobante: row.comprobante,
    totalIngresos: row.total_ingresos, totalEgresos: row.total_egresos, neto: row.total_pago,
  })));
  console.log(JSON.stringify({ knownEmployees: ids.length, requests: requests.length,
    rolesFound: roles.length, roles }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
