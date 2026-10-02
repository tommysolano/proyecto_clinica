#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Journal = require('../models/JournalEntry');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 30000 });
  const live = new Map(), stats = {};
  for await (const page of api.pages('/api/v2/contabilidad/asiento/',
    { fecha_inicial: '01/10/2026', fecha_final: '02/10/2026' }, 100, stats))
    for (const row of page.rows) live.set(String(row.id), row);
  if (!stats.complete) throw new Error(`Asientos incompletos ${stats.unique}/${stats.expected}`);
  const local = await Journal.find({ clinic: clinic._id, status: 'CONTABILIZADO',
    date: { $gte: new Date('2026-10-01T00:00:00Z'), $lt: new Date('2026-10-03T00:00:00Z') } })
    .select('number date sourceRef totalDebit').lean();
  const old = local.filter((row) => row.number?.startsWith('CTF-') && !live.has(row.number.slice(4)));
  const records = await Record.find({ _id: { $in: old.map((row) => row.sourceRef) } })
    .select('externalId payloadCompressed').lean();
  const archive = new Map(records.map((row) => [row.externalId, decodeCompressedJson(row.payloadCompressed)]));
  const identity = (row) => JSON.stringify([row?.fecha, row?.glosa, row?.detalles]);
  const result = [];
  for (const journal of old) {
    const oldId = journal.number.slice(4), archived = archive.get(oldId);
    const candidates = archived ? [...live.values()].filter((row) => identity(row) === identity(archived)) : [];
    let oldStatus;
    try { await api.get(`/api/v2/contabilidad/asiento/${oldId}/`); oldStatus = 'LIVE'; }
    catch (error) { oldStatus = error.status || error.message; }
    result.push({ oldId, oldStatus, localJournal: String(journal._id), amount: journal.totalDebit,
      candidates: candidates.map((row) => String(row.id)), sameUnique: candidates.length === 1 });
  }
  console.log(JSON.stringify({ fetched: stats.unique, local: local.length, old: result }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
