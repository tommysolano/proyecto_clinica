#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Journal = require('../models/JournalEntry');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const BankTransaction = require('../models/BankTransaction');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

const oldIds = ['JvaM73k6OIqGqXdp', 'jZdypLqnEHrErZbJ'];
const total = (row) => +(row.detalles || []).filter((line) => line.tipo === 'D')
  .reduce((sum, line) => sum + Number(line.valor || 0), 0).toFixed(2);
async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 30000 });
  const live = [], stats = {};
  for await (const page of api.pages('/api/v2/contabilidad/asiento/',
    { fecha_inicial: '01/10/2026', fecha_final: '02/10/2026' }, 100, stats)) live.push(...page.rows);
  if (!stats.complete) throw new Error('Extracción incompleta');
  const out = [];
  for (const oldId of oldIds) {
    const [record, local] = await Promise.all([
      Record.findOne({ clinic: clinic._id, entity: 'journal_entry', externalId: oldId }).lean(),
      Journal.findOne({ clinic: clinic._id, number: `CTF-${oldId}` }).lean(),
    ]);
    const old = decodeCompressedJson(record.payloadCompressed);
    const candidates = live.filter((row) => row.fecha === old.fecha && total(row) === total(old));
    const refs = await Promise.all([
      Sale.find({ clinic: clinic._id, $or: [{ journalEntry: local._id }, { costJournalEntry: local._id }] })
        .select('saleNumber total sourceRef').lean(),
      Payment.find({ clinic: clinic._id, journalEntry: local._id }).select('amount sourceRef').lean(),
      BankTransaction.find({ clinic: clinic._id, journalEntry: local._id }).select('amount reference sourceRef').lean(),
    ]);
    out.push({ oldId, old, oldJournal: { id: String(local._id), date: local.date, description: local.description,
      lines: local.lines.map((line) => ({ account: line.accountCode, debit: line.debit, credit: line.credit })) },
      linkedSales: refs[0], linkedPayments: refs[1], linkedBanks: refs[2],
      sameDateAmountCandidates: candidates.map((row) => ({ id: row.id, glosa: row.glosa,
        detalles: row.detalles })) });
  }
  console.log(JSON.stringify(out, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
