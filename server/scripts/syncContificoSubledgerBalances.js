#!/usr/bin/env node
'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ContificoRecord = require('../models/ContificoRecord');
const Receivable = require('../models/Receivable');
const Payable = require('../models/Payable');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { parseDate } = require('./migrateContifico');

const round = (value) => +Number(value || 0).toFixed(2);
const options = Object.fromEntries(process.argv.slice(2).filter((arg) => arg.startsWith('--') && arg.includes('='))
  .map((arg) => { const at = arg.indexOf('='); return [arg.slice(2, at), arg.slice(at + 1)]; }));
const commit = process.argv.includes('--commit');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const name = String(options['clinic-name'] || 'Central');
  const clinic = await Clinic.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id name').lean();
  if (!clinic) throw new Error('Clínica no encontrada');
  const cutoff = parseDate(options.cutoff || '30/09/2026');
  if (!cutoff) throw new Error('Corte inválido');
  const [receivables, payables] = await Promise.all([
    Receivable.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' }).select('_id sourceRef total applied balance status').lean(),
    Payable.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' }).select('_id sourceRef total applied balance status').lean(),
  ]);
  const arByRef = new Map(receivables.map((row) => [String(row.sourceRef), row]));
  const apByRef = new Map(payables.map((row) => [String(row.sourceRef), row]));
  const operations = { ar: [], ap: [], removeAr: [], removeAp: [] };
  const counts = { scanned: 0, settledUpdated: 0, openVerified: 0, classificationFixed: 0, voidedUpdated: 0 };
  const cursor = ContificoRecord.find({ clinic: clinic._id, entity: 'document', 'search.date': { $lte: cutoff } })
    .select('_id externalId payloadCompressed').lean().cursor({ batchSize: 250 });

  async function flush() {
    if (!commit) { operations.ar.length = 0; operations.ap.length = 0; operations.removeAr.length = 0; operations.removeAp.length = 0; return; }
    if (operations.ar.length) await Receivable.bulkWrite(operations.ar.splice(0), { ordered: false });
    if (operations.ap.length) await Payable.bulkWrite(operations.ap.splice(0), { ordered: false });
    if (operations.removeAr.length) await Receivable.deleteMany({ clinic: clinic._id, _id: { $in: operations.removeAr.splice(0) }, sourceModel: 'ContificoRecord' });
    if (operations.removeAp.length) await Payable.deleteMany({ clinic: clinic._id, _id: { $in: operations.removeAp.splice(0) }, sourceModel: 'ContificoRecord' });
  }

  for await (const record of cursor) {
    counts.scanned += 1;
    const row = decodeCompressedJson(record.payloadCompressed);
    const date = parseDate(row.fecha_emision);
    const kind = String(row.tipo_registro || '').toUpperCase();
    if (!date || date > cutoff || !['CLI', 'PRO'].includes(kind)) continue;
    const ref = String(record._id);
    const correct = kind === 'CLI' ? arByRef.get(ref) : apByRef.get(ref);
    const incorrect = kind === 'CLI' ? apByRef.get(ref) : arByRef.get(ref);
    const rawBalance = round(row.saldo);
    const sourceOpen = !row.anulado && rawBalance > 0.005;
    if (!correct && !incorrect && !sourceOpen) continue;

    const total = Math.max(0, round(row.total), rawBalance);
    const balance = row.anulado ? 0 : Math.min(total, Math.max(0, rawBalance));
    const applied = round(total - balance);
    const status = row.anulado ? 'ANULADO' : (balance <= 0.005 ? 'PAGADO' : (applied > 0 ? 'PARCIAL' : 'ABIERTO'));
    const fields = { total, applied, balance, status };
    if (correct) {
      const existing = kind === 'CLI' ? operations.ar : operations.ap;
      existing.push({ updateOne: { filter: { _id: correct._id, clinic: clinic._id }, update: { $set: fields } } });
      if (sourceOpen && round(correct.balance) === balance) counts.openVerified += 1;
      else if (balance <= 0.005 && round(correct.balance) > 0.005) counts.settledUpdated += 1;
      if (row.anulado && correct.status !== 'ANULADO') counts.voidedUpdated += 1;
    }
    if (incorrect) {
      (kind === 'CLI' ? operations.removeAp : operations.removeAr).push(incorrect._id);
      counts.classificationFixed += 1;
    }
    if (operations.ar.length + operations.ap.length + operations.removeAr.length + operations.removeAp.length >= 500) await flush();
    if (counts.scanned % 2000 === 0) console.log(`[subledger-sync] leídos ${counts.scanned}; cerrados=${counts.settledUpdated}; clasificación=${counts.classificationFixed}`);
  }
  await flush();
  console.log(JSON.stringify({ mode: commit ? 'COMMIT' : 'DRY_RUN', clinic: clinic.name, cutoff: cutoff.toISOString(), ...counts }, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
