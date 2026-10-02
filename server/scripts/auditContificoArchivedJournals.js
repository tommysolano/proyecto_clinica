#!/usr/bin/env node
'use strict';

// Conciliación por ID y multiconjunto de líneas de la última extracción completa.
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ContificoRecord = require('../models/ContificoRecord');
const ContificoMigrationRun = require('../models/ContificoMigrationRun');
const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const CostCenter = require('../models/CostCenter');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { parseDate, fmt } = require('./migrateContifico');

const cents = (value) => Number.isFinite(Number(value)) ? Math.round(Number(value) * 100) : `INVALID:${String(value)}`;
const key = (parts) => JSON.stringify(parts);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const requestedFrom = process.argv.find((arg) => arg.startsWith('--from='))?.slice('--from='.length);
  const requestedThrough = process.argv.find((arg) => arg.startsWith('--through='))?.slice('--through='.length);
  const runFilter = {
    clinic: clinic._id, phase: 'EXTRACT', status: 'COMPLETED',
    stages: { $elemMatch: { name: 'journal_entries', status: 'COMPLETED' } },
  };
  if (requestedFrom) {
    const day = parseDate(requestedFrom);
    if (!day) throw new Error('Fecha --from inválida');
    const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    runFilter['range.from'] = { $gte: start, $lt: new Date(start.getTime() + 86400000) };
  }
  if (requestedThrough) {
    const day = parseDate(requestedThrough);
    if (!day) throw new Error('Fecha --through inválida');
    const start = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
    runFilter['range.through'] = { $gte: start, $lt: new Date(start.getTime() + 86400000) };
  }
  const run = await ContificoMigrationRun.findOne(runFilter)
    .sort({ completedAt: -1, createdAt: -1 }).lean();
  if (!run) throw new Error('No hay una extracción completa para conciliar');
  const rows = await ContificoRecord.find({ clinic: clinic._id, migrationRun: run._id, entity: 'journal_entry' }).lean();
  const [rawAccounts, rawCenters, accounts, centers] = await Promise.all([
    ContificoRecord.find({ clinic: clinic._id, entity: 'chart_account' }).lean(),
    ContificoRecord.find({ clinic: clinic._id, entity: 'cost_center' }).lean(),
    ChartOfAccount.find({ clinic: clinic._id }).select('_id code type nature allowsMovement').lean(),
    CostCenter.find({ clinic: clinic._id }).select('_id code name').lean(),
  ]);
  const accountCodeBySourceId = new Map(rawAccounts.map((record) => {
    const payload = decodeCompressedJson(record.payloadCompressed);
    return [String(record.externalId), String(payload.codigo || '')];
  }));
  const accountCodeByLocalId = new Map(accounts.map((account) => [String(account._id), String(account.code)]));
  const accountByCode = new Map(accounts.map((account) => [String(account.code), account]));
  const centerCodeBySourceId = new Map(rawCenters.map((record) => {
    const payload = decodeCompressedJson(record.payloadCompressed);
    return [String(record.externalId), String(payload.codigo || '')];
  }));
  const centerCodeByLocalId = new Map(centers.map((center) => [String(center._id), String(center.code)]));
  const centerByCode = new Map(centers.map((center) => [String(center.code), center]));
  const costCenterCatalog = rawCenters.map((record) => {
    const payload = decodeCompressedJson(record.payloadCompressed) || {};
    const code = String(payload.codigo || '');
    const localCenter = centerByCode.get(code);
    return { sourceId: record.externalId, code, sourceName: String(payload.nombre || ''),
      localName: localCenter?.name || null, linked: Boolean(localCenter) };
  });
  const sourceIds = rows.map((row) => row._id);
  const local = await JournalEntry.find({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $in: sourceIds } })
    .select('sourceRef date lines').lean();
  const localByRef = new Map(local.map((entry) => [String(entry.sourceRef), entry]));
  const from = parseDate(run.range?.from);
  const through = parseDate(run.range?.through);
  if (!from || !through) throw new Error('La extracción no tiene un rango válido para auditar');
  const cutoffStart = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  const cutoffEnd = new Date(Date.UTC(through.getUTCFullYear(), through.getUTCMonth(), through.getUTCDate(), 23, 59, 59, 999));
  const allLocalInRange = await JournalEntry.find({ clinic: clinic._id, status: 'CONTABILIZADO', date: { $gte: cutoffStart, $lte: cutoffEnd } })
    .select('date lines').lean();
  const accountSums = new Map();
  const addLine = (map, code, debit, credit) => {
    const value = map.get(code) || { debit: 0, credit: 0 };
    value.debit += debit; value.credit += credit; map.set(code, value);
  };
  const sourceSums = new Map(), localSums = new Map();
  const centerActivity = new Map(), localCenterActivity = new Map();
  const addCenterActivity = (map, centerCode, accountCode, debit, credit) => {
    const activity = map.get(centerCode) || { code: centerCode, journalLines: 0, INGRESO: 0, COSTO: 0, GASTO: 0 };
    activity.journalLines += 1;
    const account = accountByCode.get(accountCode);
    if (account?.allowsMovement && Object.hasOwn(activity, account.type)) {
      activity[account.type] += account.nature === 'CREDITO' ? credit - debit : debit - credit;
    }
    map.set(centerCode, activity);
  };
  for (const record of rows) {
    const payload = decodeCompressedJson(record.payloadCompressed) || {};
    for (const line of payload.detalles || []) {
      const code = accountCodeBySourceId.get(String(line.cuenta_id)) || `?${line.cuenta_id}`;
      const value = Number(line.valor) || 0;
      addLine(sourceSums, code, String(line.tipo).toUpperCase() === 'D' ? value : 0, String(line.tipo).toUpperCase() === 'H' ? value : 0);
      const centerCode = centerCodeBySourceId.get(String(line.centro_costo_id || '')) || 'SIN_CENTRO';
      addCenterActivity(centerActivity, centerCode, code,
        String(line.tipo).toUpperCase() === 'D' ? value : 0,
        String(line.tipo).toUpperCase() === 'H' ? value : 0);
    }
  }
  for (const entry of allLocalInRange) for (const line of entry.lines || []) {
    const code = accountCodeByLocalId.get(String(line.account)) || line.accountCode || '?';
    addLine(localSums, code, Number(line.debit) || 0, Number(line.credit) || 0);
    addCenterActivity(localCenterActivity, centerCodeByLocalId.get(String(line.costCenter)) || 'SIN_CENTRO', code,
      Number(line.debit) || 0, Number(line.credit) || 0);
  }
  const statementTotals = (sums) => {
    const result = { INGRESO: 0, COSTO: 0, GASTO: 0 };
    for (const [code, amounts] of sums) {
      const account = accountByCode.get(code);
      if (!account?.allowsMovement || !Object.hasOwn(result, account.type)) continue;
      result[account.type] += account.nature === 'CREDITO'
        ? amounts.credit - amounts.debit
        : amounts.debit - amounts.credit;
    }
    for (const type of Object.keys(result)) result[type] = +result[type].toFixed(2);
    result.utilidad = +(result.INGRESO - result.COSTO - result.GASTO).toFixed(2);
    return result;
  };
  for (const code of new Set([...sourceSums.keys(), ...localSums.keys()])) {
    const source = sourceSums.get(code) || { debit: 0, credit: 0 };
    const target = localSums.get(code) || { debit: 0, credit: 0 };
    if (Math.round(source.debit * 100) !== Math.round(target.debit * 100)
      || Math.round(source.credit * 100) !== Math.round(target.credit * 100)) {
      accountSums.set(code, { sourceDebit: +source.debit.toFixed(2), localDebit: +target.debit.toFixed(2),
        sourceCredit: +source.credit.toFixed(2), localCredit: +target.credit.toFixed(2) });
    }
  }
  let dateDiff = 0, lineDiff = 0, invalidSourceDates = 0, unbalancedSource = 0;
  let unknownSourceCostCenters = 0, unknownLocalCostCenters = 0;
  const missing = [], samples = [];
  for (const record of rows) {
    const source = decodeCompressedJson(record.payloadCompressed) || {};
    const entry = localByRef.get(String(record._id));
    if (!entry) { missing.push(record.externalId); continue; }
    const sourceDate = parseDate(source.fecha);
    if (!sourceDate) invalidSourceDates += 1;
    else if (fmt(sourceDate) !== fmt(entry.date)) {
      dateDiff += 1;
      if (samples.length < 30) samples.push({ id: record.externalId, difference: 'DATE', source: fmt(sourceDate), local: fmt(entry.date) });
    }
    const sourceDebits = (source.detalles || []).filter((line) => String(line.tipo).toUpperCase() === 'D').reduce((sum, line) => sum + (Number(line.valor) || 0), 0);
    const sourceCredits = (source.detalles || []).filter((line) => String(line.tipo).toUpperCase() === 'H').reduce((sum, line) => sum + (Number(line.valor) || 0), 0);
    if (Math.abs(sourceDebits - sourceCredits) > 0.005) unbalancedSource += 1;
    const sourceLines = (source.detalles || []).map((line) => key([
      accountCodeBySourceId.get(String(line.cuenta_id)) || `?${line.cuenta_id}`,
      (() => { if (line.centro_costo_id && !centerCodeBySourceId.has(String(line.centro_costo_id))) unknownSourceCostCenters += 1;
        return centerCodeBySourceId.get(String(line.centro_costo_id || '')) || ''; })(),
      String(line.tipo).toUpperCase(), cents(line.valor),
    ])).sort();
    const localLines = (entry.lines || []).flatMap((line) => {
      const accountCode = accountCodeByLocalId.get(String(line.account)) || line.accountCode || '?';
      if (line.costCenter && !centerCodeByLocalId.has(String(line.costCenter))) unknownLocalCostCenters += 1;
      const centerCode = centerCodeByLocalId.get(String(line.costCenter)) || '';
      const parts = [];
      if (cents(line.debit) !== 0) parts.push(key([accountCode, centerCode, 'D', cents(line.debit)]));
      if (cents(line.credit) !== 0) parts.push(key([accountCode, centerCode, 'H', cents(line.credit)]));
      return parts;
    }).sort();
    if (JSON.stringify(sourceLines) !== JSON.stringify(localLines)) {
      lineDiff += 1;
      if (samples.length < 30) samples.push({ id: record.externalId, difference: 'LINES', sourceLines, localLines });
    }
  }
  const localOnly = await JournalEntry.countDocuments({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: { $nin: sourceIds } });
  const formatCenterActivity = (map) => [...map.values()].sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }))
    .map((row) => ({ code: row.code, journalLines: row.journalLines,
      income: +row.INGRESO.toFixed(2), cost: +row.COSTO.toFixed(2), expense: +row.GASTO.toFixed(2),
      profit: +(row.INGRESO - row.COSTO - row.GASTO).toFixed(2) }));
  const sourceCenterActivity = formatCenterActivity(centerActivity);
  const targetCenterActivity = formatCenterActivity(localCenterActivity);
  const centerActivityDifferences = [];
  const localCenterRows = new Map(targetCenterActivity.map((row) => [row.code, row]));
  for (const row of sourceCenterActivity) {
    const target = localCenterRows.get(row.code);
    if (!target || row.journalLines !== target.journalLines || ['income', 'cost', 'expense'].some((field) => Math.round(row[field] * 100) !== Math.round(target[field] * 100))) {
      centerActivityDifferences.push({ source: row, local: target || null });
    }
    localCenterRows.delete(row.code);
  }
  for (const row of localCenterRows.values()) centerActivityDifferences.push({ source: null, local: row });
  const report = {
    clinic: clinic.name,
    range: { from: fmt(from), through: fmt(through) },
    extraction: { id: String(run._id), completedAt: run.completedAt, records: rows.length,
      expected: run.stages?.find((stage) => stage.name === 'journal_entries')?.expected ?? null,
      recovered: run.stages?.find((stage) => stage.name === 'journal_entries')?.recovered ?? null },
    localProjectedForSource: local.length,
    localEntriesInRange: allLocalInRange.length,
    costCenters: costCenterCatalog,
    costCenterActivity: { source: sourceCenterActivity, local: targetCenterActivity, differences: centerActivityDifferences },
    unknownSourceCostCenters,
    unknownLocalCostCenters,
    incomeStatementFromJournalEntries: { source: statementTotals(sourceSums), local: statementTotals(localSums) },
    accountsWithDebitOrCreditDifferences: accountSums.size,
    accountDifferenceSamples: [...accountSums.entries()].slice(0, 30).map(([code, values]) => ({ code, ...values })),
    missingLocal: missing.length,
    localOnlyOutsideThisExtraction: localOnly,
    dateDifferences: dateDiff,
    lineDifferences: lineDiff,
    invalidSourceDates,
    unbalancedSource,
    samples,
    completeMatch: rows.length === run.stages?.find((stage) => stage.name === 'journal_entries')?.expected
      && local.length === rows.length && allLocalInRange.length === rows.length && accountSums.size === 0
      && missing.length === 0 && dateDiff === 0 && lineDiff === 0
      && invalidSourceDates === 0 && unbalancedSource === 0
      && unknownSourceCostCenters === 0 && unknownLocalCostCenters === 0 && centerActivityDifferences.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!report.completeMatch) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
