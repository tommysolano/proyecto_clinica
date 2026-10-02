#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Journal = require('../models/JournalEntry');
const { ContificoApi } = require('../services/contificoApi');
const { checksum, search } = require('./migrateContifico');
const { decodeCompressedJson } = require('../utils/compressedJson');

const option = (key) => process.argv.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);

async function main() {
  const oldId = option('old'), newId = option('new'), commit = process.argv.includes('--commit');
  if (!oldId || !newId || oldId === newId) throw new Error('Se requieren --old y --new distintos');
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  const live = await api.get(`/api/v2/contabilidad/asiento/${newId}/`);
  try {
    await api.get(`/api/v2/contabilidad/asiento/${oldId}/`);
    throw new Error('El ID anterior aún existe en Contífico');
  } catch (error) { if (error.status !== 406 && error.status !== 404) throw error; }
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const old = await Record.findOne({ clinic: clinic._id, entity: 'journal_entry', externalId: oldId }).lean();
  const newSource = await Record.findOne({ clinic: clinic._id, entity: 'journal_entry', externalId: newId }).lean();
  const local = await Journal.findOne({ clinic: clinic._id, number: `CTF-${oldId}` }).lean();
  if (!old || newSource || !local || await Journal.exists({ clinic: clinic._id, number: `CTF-${newId}` }))
    throw new Error('Estado local incompatible con reemplazo');
  const archived = decodeCompressedJson(old.payloadCompressed);
  const identity = (row) => JSON.stringify([row.fecha, row.glosa, row.detalles]);
  if (identity(live) !== identity(archived)) throw new Error('El asiento nuevo no tiene contenido idéntico');
  const report = { mode: commit ? 'COMMIT' : 'DRY_RUN', oldId, newId,
    date: live.fecha, amount: Number(local.totalDebit), journalLocalId: String(local._id) };
  if (commit) {
    const folder = path.resolve(__dirname, '..', 'storage', 'contifico-batches');
    fs.mkdirSync(folder, { recursive: true });
    const backup = path.join(folder, `journal-replacement-${oldId}-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.gz`);
    fs.writeFileSync(backup, zlib.gzipSync(Buffer.from([
      EJSON.stringify(old, { relaxed: false }), EJSON.stringify(local, { relaxed: false }),
    ].join('\n') + '\n'), { level: 9 }), { flag: 'wx' });
    const created = await Record.create({ clinic: clinic._id, entity: 'journal_entry', externalId: newId,
      payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(live)), { level: 9 }), payloadEncoding: 'gzip-json',
      checksum: checksum(live), capturedAt: new Date(), search: search('journal_entry', live),
      projection: { status: 'LINKED_EXISTING', links: [{ model: 'JournalEntry', ref: local._id, action: 'LINK' }], warnings: [] } });
    await Journal.updateOne({ _id: local._id, number: `CTF-${oldId}` },
      { $set: { number: `CTF-${newId}`, sourceRef: created._id } });
    await Record.updateOne({ _id: old._id }, { $set: { projection: {
      status: 'REVIEW', links: [], warnings: [`Reemplazado en Contífico por ${newId}`], projectedAt: new Date(),
    } } });
    report.backup = backup;
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
