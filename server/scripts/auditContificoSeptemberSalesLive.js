#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Sale = require('../models/Sale');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

const round = (value) => +Number(value || 0).toFixed(2);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const stats = {}, live = [];
  let pagesRead = 0;
  for await (const page of api.pages('/api/v2/documento/', {
    tipo_registro: 'CLI', fecha_inicial: '01/09/2026', fecha_final: '30/09/2026',
  }, 100, stats)) {
    pagesRead += 1;
    live.push(...page.rows.filter((row) => row.tipo_registro === 'CLI' &&
      ['FAC', 'NVE'].includes(row.tipo_documento) && /^\d{2}\/09\/2026$/.test(row.fecha_emision)));
    if (pagesRead % 5 === 0) console.log(`[ventas-septiembre] páginas ${pagesRead}; documentos ${live.length}`);
  }
  const archived = await Record.find({ clinic: clinic._id, entity: 'document',
    'search.date': { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
    .select('externalId payloadCompressed').lean();
  const archiveById = new Map(archived.filter((record) => {
    const row = decodeCompressedJson(record.payloadCompressed);
    return row.tipo_registro === 'CLI' && ['FAC', 'NVE'].includes(row.tipo_documento);
  }).map((record) => [record.externalId, decodeCompressedJson(record.payloadCompressed)]));
  const local = await Sale.find({ clinic: clinic._id,
    idempotencyKey: { $in: live.map((row) => `contifico:${row.id}`) } })
    .select('idempotencyKey saleNumber total taxAmount').lean();
  const localById = new Map(local.map((row) => [row.idempotencyKey.slice('contifico:'.length), row]));
  const liveIds = new Set(live.map((row) => row.id));
  const missingArchive = live.filter((row) => !archiveById.has(row.id));
  const changedArchive = live.filter((row) => {
    const old = archiveById.get(row.id);
    return old && (old.documento !== row.documento || round(old.total) !== round(row.total) ||
      round(old.iva) !== round(row.iva) || round(old.saldo) !== round(row.saldo));
  });
  const missingLocal = live.filter((row) => !localById.has(row.id));
  const changedLocal = live.filter((row) => {
    const old = localById.get(row.id);
    return old && (old.saleNumber !== row.documento || round(old.total) !== round(row.total) ||
      round(old.taxAmount) !== round(row.iva));
  });
  console.log(JSON.stringify({ liveCount: live.length, uniqueLive: liveIds.size,
    liveTotal: round(live.reduce((sum, row) => sum + Number(row.total || 0), 0)),
    archivedCount: archiveById.size, localCount: local.length, pagesRead, stats,
    missingArchive: missingArchive.length, missingArchiveSamples: missingArchive.slice(0, 15)
      .map((row) => ({ id: row.id, number: row.documento, total: round(row.total) })),
    archiveMissingFromList: [...archiveById.keys()].filter((id) => !liveIds.has(id)).length,
    changedArchive: changedArchive.length, changedArchiveSamples: changedArchive.slice(0, 15)
      .map((row) => ({ id: row.id, number: row.documento, total: round(row.total) })),
    missingLocal: missingLocal.length, changedLocal: changedLocal.length }, null, 2));
  if (liveIds.size !== live.length || missingArchive.length || changedArchive.length ||
    missingLocal.length || changedLocal.length) process.exitCode = 2;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
