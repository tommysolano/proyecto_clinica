#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Sale = require('../models/Sale');
const CostCenter = require('../models/CostCenter');
const { decodeCompressedJson } = require('../utils/compressedJson');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const [source, centerRecords, localCenters] = await Promise.all([
    Record.find({ clinic: clinic._id, entity: 'document',
      'search.date': { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
      .select('externalId payloadCompressed').lean(),
    Record.find({ clinic: clinic._id, entity: 'cost_center' }).select('externalId payloadCompressed').lean(),
    CostCenter.find({ clinic: clinic._id }).select('_id code name').lean(),
  ]);
  const centerCodeBySource = new Map(centerRecords.map((row) => {
    const data = decodeCompressedJson(row.payloadCompressed);
    return [String(row.externalId), String(data.codigo || '')];
  }));
  const centerCodeByLocal = new Map(localCenters.map((row) => [String(row._id), row.code]));
  const sales = source.map((row) => ({ record: row, payload: decodeCompressedJson(row.payloadCompressed) }))
    .filter(({ payload }) => payload.tipo_registro === 'CLI' && ['FAC', 'NVE'].includes(payload.tipo_documento));
  const local = await Sale.find({ clinic: clinic._id,
    idempotencyKey: { $in: sales.map(({ record }) => `contifico:${record.externalId}`) } })
    .select('idempotencyKey costCenter total saleNumber').lean();
  const localById = new Map(local.map((row) => [row.idempotencyKey.slice('contifico:'.length), row]));
  const byCenter = new Map();
  const issues = [];
  let mixed = 0, withoutCenter = 0, matched = 0;
  for (const { record, payload } of sales) {
    const codes = [...new Set((payload.detalles || []).map((item) => {
      const id = String(item.centro_costo_id || '');
      return id ? centerCodeBySource.get(id) || `?${id}` : '';
    }).filter(Boolean))];
    const target = localById.get(record.externalId);
    const localCode = target?.costCenter ? centerCodeByLocal.get(String(target.costCenter)) || '?' : '';
    if (!codes.length) withoutCenter += 1;
    if (codes.length > 1) mixed += 1;
    if (target && codes.length <= 1 && localCode === (codes[0] || '')) matched += 1;
    else if (issues.length < 30) issues.push({ id: record.externalId,
      number: payload.documento, sourceCenters: codes, localCenter: localCode, localExists: !!target });
    const key = codes.length === 1 ? codes[0] : codes.length ? 'MIXTO' : 'SIN_CENTRO';
    const group = byCenter.get(key) || { center: key, documents: 0, total: 0 };
    group.documents += 1;
    group.total += Number(payload.total || 0);
    byCenter.set(key, group);
  }
  const report = { documents: sales.length, local: local.length,
    singleOrNoCenterMatched: matched, mixedCenterDocuments: mixed, withoutCenter,
    byCenter: [...byCenter.values()].map((row) => ({ ...row, total: +row.total.toFixed(2) }))
      .sort((a, b) => a.center.localeCompare(b.center)), issues };
  console.log(JSON.stringify(report, null, 2));
  if (mixed || issues.length || local.length !== sales.length) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
