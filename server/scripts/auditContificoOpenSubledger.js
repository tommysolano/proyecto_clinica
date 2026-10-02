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

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: new RegExp(`^${String(options['clinic-name'] || 'Central').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }).select('_id name').lean();
  if (!clinic) throw new Error('Clínica no encontrada');
  const cutoff = parseDate(options.cutoff || '30/09/2026');
  if (!cutoff) throw new Error('Corte inválido');
  const rows = { CLI: [], PRO: [] };
  const retired = [];
  const cursor = ContificoRecord.find({ clinic: clinic._id, entity: 'document', 'search.date': { $lte: cutoff } })
    .select('externalId payloadCompressed projection').lean().cursor({ batchSize: 250 });
  let scanned = 0;
  for await (const record of cursor) {
    scanned += 1;
    let payload;
    try { payload = decodeCompressedJson(record.payloadCompressed); }
    catch (error) { console.log(`[audit-subledger] decode error ${record.externalId}: ${error.message}`); continue; }
    const date = parseDate(payload.fecha_emision);
    const reg = String(payload.tipo_registro || '').toUpperCase();
    const balance = round(payload.saldo);
    if (!date || date > cutoff || payload.anulado || balance <= 0.005 || !rows[reg]) continue;
    if (record.projection?.status === 'REVIEW' &&
        (record.projection.warnings || []).some((warning) => warning.startsWith('Ausente de la instantánea Contífico '))) {
      retired.push({ id: record.externalId, register: reg, balance });
      continue;
    }
    rows[reg].push({ ref: String(record._id), id: record.externalId, total: Math.max(balance, round(payload.total)), balance });
    if (scanned % 1000 === 0) console.log(`[audit-subledger] leídos ${scanned}; abiertos CLI=${rows.CLI.length} PRO=${rows.PRO.length}`);
  }
  const [receivables, payables] = await Promise.all([
    Receivable.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' }).select('sourceRef total balance').lean(),
    Payable.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' }).select('sourceRef total balance').lean(),
  ]);
  function compare(source, local) {
    const byRef = new Map(local.map((row) => [String(row.sourceRef), row]));
    const sourceRefs = new Set(source.map((row) => row.ref));
    const differences = [];
    for (const expected of source) {
      const actual = byRef.get(expected.ref);
      if (!actual || round(actual.total) !== expected.total || round(actual.balance) !== expected.balance) {
        differences.push({ id: expected.id, expected: { total: expected.total, balance: expected.balance }, actual: actual && { total: round(actual.total), balance: round(actual.balance) } });
      }
    }
    return {
      sourceCount: source.length, localCount: local.length,
      localOpenCount: local.filter((row) => round(row.balance) > 0.005).length,
      openCountMatch: source.length === local.filter((row) => round(row.balance) > 0.005).length,
      sourceTotal: round(source.reduce((sum, row) => sum + row.total, 0)),
      localTotal: round(local.reduce((sum, row) => sum + round(row.total), 0)),
      sourceBalance: round(source.reduce((sum, row) => sum + row.balance, 0)),
      localBalance: round(local.reduce((sum, row) => sum + round(row.balance), 0)),
      openBalanceMatch: Math.abs(source.reduce((sum, row) => sum + row.balance, 0) - local.reduce((sum, row) => sum + round(row.balance), 0)) < 0.01,
      differences: differences.length,
      extra: local.filter((row) => !sourceRefs.has(String(row.sourceRef))).length,
      extraOpen: local.filter((row) => !sourceRefs.has(String(row.sourceRef)) && round(row.balance) > 0.005).length,
      samples: differences.slice(0, 25),
      extraRows: local.filter((row) => !sourceRefs.has(String(row.sourceRef))).map((row) => ({
        ref: String(row.sourceRef), total: round(row.total), balance: round(row.balance),
      })),
    };
  }
  const receivableReport = compare(rows.CLI, receivables);
  const payableReport = compare(rows.PRO, payables);
  const localByRef = new Map([...receivables, ...payables].map((row) => [String(row.sourceRef), row]));
  const extras = [...receivableReport.extraRows.map((row) => ({ ...row, ledger: 'CxC' })),
    ...payableReport.extraRows.map((row) => ({ ...row, ledger: 'CxP' }))];
  const extraIds = [...new Set(extras.map((row) => row.ref))];
  const sourceByRef = new Map();
  for (let offset = 0; offset < extraIds.length; offset += 250) {
    const records = await ContificoRecord.find({ clinic: clinic._id, entity: 'document', _id: { $in: extraIds.slice(offset, offset + 250) } })
      .select('_id externalId payloadCompressed').lean();
    for (const record of records) {
      const payload = decodeCompressedJson(record.payloadCompressed);
      sourceByRef.set(String(record._id), {
        id: record.externalId, date: parseDate(payload.fecha_emision)?.toISOString().slice(0, 10) || null,
        register: String(payload.tipo_registro || '').toUpperCase(), type: String(payload.tipo_documento || '').toUpperCase(),
        total: round(payload.total), balance: round(payload.saldo), voided: Boolean(payload.anulado),
      });
    }
  }
  const extraBreakdown = { CxC: {}, CxP: {} };
  for (const row of extras) {
    const source = sourceByRef.get(row.ref);
    const reason = !source ? 'fuente_ausente' : source.voided ? 'anulado' : source.balance <= 0.005 ? 'fuente_saldada' : source.date > cutoff.toISOString().slice(0, 10) ? 'posterior_corte' : 'fuente_no_abierta_en_estado_actual';
    const group = extraBreakdown[row.ledger][reason] || (extraBreakdown[row.ledger][reason] = { count: 0, localBalance: 0, sourceBalance: 0, samples: [] });
    group.count += 1; group.localBalance = round(group.localBalance + row.balance); group.sourceBalance = round(group.sourceBalance + (source?.balance || 0));
    if (group.samples.length < 12) group.samples.push({ id: source?.id || row.ref, source, local: { total: row.total, balance: row.balance } });
  }
  delete receivableReport.extraRows;
  delete payableReport.extraRows;
  console.log(JSON.stringify({ clinic: clinic.name, cutoff: cutoff.toISOString(), scanned,
    retiredArchiveRecords: retired, receivables: receivableReport, payables: payableReport, extraBreakdown }, null, 2));
  if ([receivableReport, payableReport].some((report) => !report.openCountMatch ||
      !report.openBalanceMatch || report.differences || report.extraOpen)) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
