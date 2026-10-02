#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const Clinic = require('../models/Clinic');
const Run = require('../models/ContificoMigrationRun');
const Record = require('../models/ContificoRecord');
const Journal = require('../models/JournalEntry');
const { ContificoApi } = require('../services/contificoApi');

const commit = process.argv.includes('--commit');
const value = (name) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const from = value('from'), through = value('through'), expected = Number(value('expected'));
if (!/^\d{4}-\d{2}-\d{2}$/.test(from || '') || !/^\d{4}-\d{2}-\d{2}$/.test(through || '') ||
    !Number.isInteger(expected) || expected < 0) throw new Error('Se requieren --from=YYYY-MM-DD --through=YYYY-MM-DD --expected=N');

async function references(clinicId, journalId) {
  const names = fs.readdirSync(path.join(__dirname, '..', 'models')).filter((name) => name.endsWith('.js'));
  for (const name of names) require(path.join(__dirname, '..', 'models', name));
  const found = [];
  for (const model of Object.values(mongoose.models)) {
    if (!model.schema.path('clinic')) continue;
    const paths = [];
    model.schema.eachPath((field, schemaType) => {
      if (schemaType.options?.ref === 'JournalEntry' || schemaType.caster?.options?.ref === 'JournalEntry') paths.push(field);
    });
    for (const field of paths) {
      const query = { clinic: clinicId, [field]: journalId };
      if (model.modelName === 'JournalEntry') query._id = { $ne: journalId };
      const row = await model.findOne(query).select('_id').lean();
      if (row) found.push({ model: model.modelName, field, id: String(row._id) });
    }
  }
  return found;
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const snapshot = await Run.findOne({ clinic: clinic._id, phase: 'EXTRACT', status: 'COMPLETED',
    'stages.name': 'journal_entries' }).sort({ completedAt: -1 }).lean();
  const stage = snapshot?.stages?.find((item) => item.name === 'journal_entries');
  if (!snapshot || stage?.status !== 'COMPLETED' || stage.expected !== stage.unique ||
      snapshot.range.from > new Date(`${from}T12:00:00Z`) || snapshot.range.through < new Date(`${through}T12:00:00Z`))
    throw new Error('No existe instantánea completa que cubra todo el rango');
  const current = await Record.find({ clinic: clinic._id, entity: 'journal_entry', migrationRun: snapshot._id })
    .select('externalId').lean();
  if (current.length !== stage.unique) throw new Error(`Instantánea inconsistente ${current.length}/${stage.unique}`);
  const currentIds = new Set(current.map((row) => row.externalId));
  const local = await Journal.find({ clinic: clinic._id, source: 'MIGRACION', sourceModel: 'ContificoRecord',
    status: 'CONTABILIZADO', date: { $gte: new Date(`${from}T00:00:00Z`),
      $lt: new Date(new Date(`${through}T00:00:00Z`).getTime() + 86400000) } }).lean();
  const missing = local.filter((row) => row.number.startsWith('CTF-') && !currentIds.has(row.number.slice(4)));
  if (missing.length !== expected) throw new Error(`Se esperaban ${expected} asientos ausentes; hay ${missing.length}`);
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  const confirmed = [];
  for (const journal of missing) {
    const id = journal.number.slice(4);
    const record = await Record.findById(journal.sourceRef).lean();
    if (!record || record.entity !== 'journal_entry' || record.externalId !== id) throw new Error(`Origen inválido ${id}`);
    try { await api.get(`/api/v2/contabilidad/asiento/${id}/`); throw new Error(`Asiento ${id} sigue vivo`); }
    catch (error) { if (![404, 406].includes(error.status)) throw error; }
    const backlinks = await references(clinic._id, journal._id);
    if (backlinks.length) throw new Error(`Asiento ${id} tiene referencias: ${JSON.stringify(backlinks)}`);
    confirmed.push({ id, journal, record });
  }
  const report = { mode: commit ? 'COMMIT' : 'DRY_RUN', snapshot: String(snapshot._id),
    checked: local.length, retired: confirmed.map(({ id, journal }) => ({ id, amount: journal.totalDebit })) };
  if (commit && confirmed.length) {
    const folder = path.join(__dirname, '..', 'storage', 'contifico-batches');
    fs.mkdirSync(folder, { recursive: true });
    const backup = path.join(folder, `retired-journals-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson.gz`);
    fs.writeFileSync(backup, zlib.gzipSync(Buffer.from(confirmed.flatMap(({ journal, record }) => [
      EJSON.stringify(journal, { relaxed: false }), EJSON.stringify(record, { relaxed: false }),
    ]).join('\n') + '\n')), { flag: 'wx' });
    for (const { id, journal, record } of confirmed) {
      const result = await Journal.updateOne({ _id: journal._id, status: 'CONTABILIZADO', sourceRef: record._id },
        { $set: { status: 'ANULADO', reversalReason: `ID ${id} ausente de la instantánea completa y del API directo de Contífico` } });
      if (result.modifiedCount !== 1) throw new Error(`Cambio concurrente de ${id}; restaurar desde ${backup}`);
      await Record.updateOne({ _id: record._id }, { $set: { projection: { status: 'REVIEW', links: [],
        warnings: [`Ausente de la instantánea Contífico ${snapshot._id}; API directo 404/406`], projectedAt: new Date() } } });
    }
    report.backup = backup;
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
