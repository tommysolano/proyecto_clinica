#!/usr/bin/env node
'use strict';

// Restaura solamente los documentos tocados por el lote interrumpido del
// 01/10/2026. Conserva una copia EJSON de su estado antes de la restauración.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const Clinic = require('../models/Clinic');
const Run = require('../models/ContificoMigrationRun');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const Sale = require('../models/Sale');

const runId = '6abec4743ee84dbeee26a7cc';
const prior = path.resolve(__dirname, '..', 'storage', 'contifico-backups',
  'Central-2026-10-01T19-53-07-095Z', 'contificorecords.ndjson.gz');

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const run = await Run.findOne({ _id: runId, clinic: clinic._id, phase: 'EXTRACT', status: 'RUNNING' }).lean();
  if (!run) throw new Error('El lote interrumpido ya no está en RUNNING');
  const touched = await Record.find({ clinic: clinic._id, entity: 'document', migrationRun: run._id }).lean();
  const ids = new Set(touched.map((row) => String(row._id)));
  const originals = new Map();
  const input = fs.createReadStream(prior).pipe(zlib.createGunzip());
  for await (const line of readline.createInterface({ input })) {
    const match = line.match(/^\{"_id":\{"\$oid":"([a-f0-9]{24})"/);
    if (match && ids.has(match[1])) originals.set(match[1], EJSON.parse(line, { relaxed: false }));
  }
  const newRows = touched.filter((row) => !originals.has(String(row._id)));
  if (newRows.some((row) => row.projection?.status !== 'ARCHIVED' || (row.projection?.links || []).length))
    throw new Error('Un documento nuevo del lote ya tiene proyección; restauración detenida');
  const newIds = newRows.map((row) => row._id);
  const [purchaseLinks, saleLinks] = await Promise.all([
    Purchase.countDocuments({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: newIds } }),
    Sale.countDocuments({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: newIds } }),
  ]);
  if (purchaseLinks || saleLinks) throw new Error('Documentos nuevos enlazados a compras/ventas');
  const report = { mode: commit ? 'COMMIT' : 'DRY_RUN', run: runId,
    touched: touched.length, restoredFromBackup: originals.size, newUnprojectedRemoved: newRows.length };
  if (commit) {
    const folder = path.resolve(__dirname, '..', 'storage', 'contifico-backups');
    const backup = path.join(folder, `interrupted-documents-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.gz`);
    const content = touched.map((row) => EJSON.stringify(row, { relaxed: false })).join('\n') + '\n';
    fs.writeFileSync(backup, zlib.gzipSync(Buffer.from(content), { level: 9 }), { flag: 'wx' });
    report.preRestoreBackup = backup;
    const operations = [...originals.values()].map((row) => ({ replaceOne: {
      filter: { _id: row._id, clinic: clinic._id, entity: 'document', migrationRun: run._id },
      replacement: row,
    } }));
    for (let offset = 0; offset < operations.length; offset += 200) {
      const result = await Record.collection.bulkWrite(operations.slice(offset, offset + 200), { ordered: false });
      if (result.modifiedCount !== operations.slice(offset, offset + 200).length)
        throw new Error('No se restauraron todos los registros del bloque');
    }
    if (newIds.length) {
      const result = await Record.deleteMany({ _id: { $in: newIds }, clinic: clinic._id,
        entity: 'document', migrationRun: run._id, 'projection.status': 'ARCHIVED' });
      if (result.deletedCount !== newIds.length) throw new Error('No se retiraron todos los registros nuevos sin proyección');
    }
    await Run.updateOne({ _id: run._id, status: 'RUNNING' }, { $set: { status: 'FAILED', completedAt: new Date(),
      issues: [{ stage: 'documents', message: 'Extracción interrumpida tras avance lento; registros restaurados desde respaldo previo.' }] } });
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
