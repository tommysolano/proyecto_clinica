#!/usr/bin/env node
'use strict';

/**
 * Permite conservar dos documentos HISTÓRICOS distintos de Contífico que comparten
 * proveedor y serie. La interfaz continúa bloqueando la creación manual duplicada;
 * el índice único anterior impedía representar fielmente el origen.
 *
 *   node scripts/relaxContificoPurchaseSeriesIndex.js
 *   node scripts/relaxContificoPurchaseSeriesIndex.js --commit
 */

require('dotenv').config();
const mongoose = require('mongoose');
const PurchaseInvoice = require('../models/PurchaseInvoice');

async function main() {
  const commit = process.argv.includes('--commit');
  if (!process.env.MONGODB_URI) throw new Error('Falta MONGODB_URI');
  await mongoose.connect(process.env.MONGODB_URI);
  const indexes = await PurchaseInvoice.collection.indexes();
  const legacy = indexes.find((index) => index.name === 'clinic_1_supplier_1_serie_1');
  const isExpected = legacy
    && legacy.unique === true
    && JSON.stringify(legacy.key) === JSON.stringify({ clinic: 1, supplier: 1, serie: 1 });
  console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', legacyIndex: legacy || null, action: isExpected ? 'DROP_UNIQUE_AND_RECREATE_NON_UNIQUE' : 'NO_CHANGE' }, null, 2));
  if (!commit || !isExpected) return;
  await PurchaseInvoice.collection.dropIndex(legacy.name);
  await PurchaseInvoice.collection.createIndex({ clinic: 1, supplier: 1, serie: 1 }, { name: legacy.name });
  console.log('Índice de serie histórica actualizado.');
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));
