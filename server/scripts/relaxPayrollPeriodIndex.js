#!/usr/bin/env node
'use strict';

/**
 * Retira exclusivamente el índice histórico que impedía que una quincena y
 * un cierre de mes coexistieran. Antes de cambiar nada valida que ya exista el
 * índice correcto por tipo de período.
 *
 *   node scripts/relaxPayrollPeriodIndex.js
 *   node scripts/relaxPayrollPeriodIndex.js --commit
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Payroll = require('../models/Payroll');

const sameKey = (index, key) => JSON.stringify(index?.key) === JSON.stringify(key);

async function main() {
  const commit = process.argv.includes('--commit');
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);

  const indexes = await Payroll.collection.indexes();
  const legacyKey = { clinic: 1, year: 1, month: 1 };
  const targetKey = { clinic: 1, year: 1, month: 1, periodType: 1 };
  const legacy = indexes.find((index) => index.name === 'clinic_1_year_1_month_1');
  const target = indexes.find((index) => index.name === 'clinic_1_year_1_month_1_periodType_1');
  const legacyExpected = legacy?.unique === true && sameKey(legacy, legacyKey);
  const targetExpected = target?.unique === true && sameKey(target, targetKey);
  const action = legacyExpected && targetExpected
    ? 'DROP_LEGACY_UNIQUE_INDEX'
    : (!legacy && targetExpected ? 'ALREADY_RELAXED' : 'NO_CHANGE');

  console.log(JSON.stringify({
    mode: commit ? 'COMMIT' : 'DRY_RUN',
    legacyIndex: legacy || null,
    periodTypeIndex: target || null,
    action,
  }, null, 2));

  if (!commit || action !== 'DROP_LEGACY_UNIQUE_INDEX') return;
  await Payroll.collection.dropIndex(legacy.name);
  console.log('Índice histórico de nómina retirado; se conserva la unicidad por tipo de período.');
}

if (require.main === module) main()
  .catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));

module.exports = { sameKey };
