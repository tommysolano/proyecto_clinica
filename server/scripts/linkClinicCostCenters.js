#!/usr/bin/env node
'use strict';
// Liga cada sucursal con su centro de costo de Contífico (los centros viven en Central).
// Uso: node scripts/linkClinicCostCenters.js [--commit]
// Indicado por la contabilidad el 02/10/2026: Central → CC CENTRAL (1),
// Extensión → CC EXTENSIÓN (2), Laboratorio → CC LABORATORIO (5).
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const CostCenter = require('../models/CostCenter');

const LINKS = [
  { clinic: /^central$/i, code: '1' },
  { clinic: /^extensi[oó]n$/i, code: '2' },
  { clinic: /^laboratorio$/i, code: '5' },
];

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);
  const central = await Clinic.findOne({ name: /^central$/i }).lean();
  if (!central) throw new Error('Clínica Central no encontrada');
  for (const link of LINKS) {
    const clinic = await Clinic.findOne({ name: link.clinic }).lean();
    const costCenter = await CostCenter.findOne({ clinic: central._id, code: link.code }).lean();
    if (!clinic || !costCenter) throw new Error(`No se encontró ${link.clinic} o el centro ${link.code}`);
    console.log(`${commit ? 'LIGADA' : 'SIMULACIÓN'}: ${clinic.name} → ${costCenter.code} ${costCenter.name}`);
    if (commit) await Clinic.updateOne({ _id: clinic._id }, { $set: { accountingCostCenter: costCenter._id } });
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
