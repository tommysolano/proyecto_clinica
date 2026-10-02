#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { parse } = require('csv-parse/sync');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const { ContificoApi } = require('../services/contificoApi');
const { checksum } = require('./migrateContifico');
const { decodeCompressedJson } = require('../utils/compressedJson');

const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
const reportFile = process.argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length);
const money = (value) => +Number(String(value || '0').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')).toFixed(2);
const round = (value) => +Number(value || 0).toFixed(2);
const key = (date, id, voucher, amount) => [date, String(id || ''), String(voucher || ''), round(amount)].join('|');

async function main() {
  if (!input) throw new Error('Falta --input');
  const gui = parse(fs.readFileSync(input, 'utf8'), { delimiter: '\t', columns: true,
    relax_quotes: true, relax_column_count: true, skip_empty_lines: true })
    .filter((row) => row.Tipo === 'Cobro' && /^\d{2}\/09\/2026$/.test(row.Fecha));
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const pages = [];
  for (const page of [1, 2, 3]) pages.push(await api.listV1('/api/v1/registro/transaccion/',
    { result_size: 1000, result_page: page }));
  const all = pages.flat();
  const uniqueAll = new Set(all.map((row) => row.id));
  const live = all.filter((row) => row.tipo === 'C' && /^\d{2}\/09\/2026$/.test(row.fecha_emision));
  const uniqueLive = new Set(live.map((row) => row.id));
  const source = await Record.find({ clinic: clinic._id, entity: 'transaction',
    'search.type': 'C', 'search.date': { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') } })
    .select('externalId checksum').lean();
  const archived = new Map(source.map((row) => [row.externalId, row]));
  const people = await Record.find({ clinic: clinic._id, entity: 'person',
    externalId: { $in: [...new Set(live.map((row) => row.persona_id).filter(Boolean))] } })
    .select('externalId payloadCompressed').lean();
  const personById = new Map(people.map((record) => [record.externalId,
    decodeCompressedJson(record.payloadCompressed)]));
  const local = await Payment.find({ clinic: clinic._id, type: 'COBRO',
    idempotencyKey: { $in: live.map((row) => `contifico:transaction:${row.id}`) } })
    .select('idempotencyKey total').lean();
  const localIds = new Set(local.map((row) => row.idempotencyKey.slice('contifico:transaction:'.length)));
  const counts = (items, makeKey) => { const map = new Map();
    for (const row of items) { const id = makeKey(row); map.set(id, (map.get(id) || 0) + 1); } return map; };
  const guiCounts = counts(gui, (row) => key(row.Fecha, row['Identificación'], row['#Comprobante'], money(row.Valor)));
  const liveCounts = counts(live, (row) => {
    const person = personById.get(row.persona_id);
    return key(row.fecha_emision, person?.ruc || person?.cedula,
      row.numero_comprobante, row.total);
  });
  const only = (left, right) => [...left].filter(([id, count]) => count > (right.get(id) || 0))
    .map(([id, count]) => ({ key: id, count: count - (right.get(id) || 0) }));
  const missing = live.filter((row) => !archived.has(row.id));
  const missingGui = missing.map((row) => {
    const person = personById.get(row.persona_id);
    const expectedKey = key(row.fecha_emision, person?.ruc || person?.cedula,
      row.numero_comprobante, row.total);
    const screens = gui.filter((screen) => key(screen.Fecha, screen['Identificación'],
      screen['#Comprobante'], money(screen.Valor)) === expectedKey);
    return { id: row.id, accounts: [...new Set(screens.map((screen) => screen['Código Cta Afectada']))],
      methods: [...new Set(screens.map((screen) => screen['Forma Cobro/Pago']))],
      guiRows: screens.length };
  });
  const missingDocIds = [...new Set(missing.flatMap((row) => [row.documento_id,
    ...(row.detalles || []).map((detail) => detail.documento_id)].filter(Boolean)))];
  const documents = await Record.find({ clinic: clinic._id, entity: 'document',
    externalId: { $in: missingDocIds } }).select('_id externalId').lean();
  const docById = new Map(documents.map((row) => [row.externalId, row]));
  const sales = await Sale.find({ clinic: clinic._id,
    idempotencyKey: { $in: missingDocIds.map((id) => `contifico:${id}`) } })
    .select('idempotencyKey').lean();
  const saleIds = new Set(sales.map((row) => row.idempotencyKey.slice('contifico:'.length)));
  const missingTargets = missing.map((row) => ({ id: row.id, total: round(row.total),
    targets: (row.detalles || []).filter((detail) => round(detail.valor_pago) > 0 && detail.documento_id)
      .map((detail) => ({ id: detail.documento_id, amount: round(detail.valor_pago) })) }))
    .map((row) => ({ ...row, targets: row.targets.length ? row.targets :
      (live.find((item) => item.id === row.id)?.documento_id ?
        [{ id: live.find((item) => item.id === row.id).documento_id, amount: row.total }] : []) }))
    .filter((row) => round(row.targets.reduce((sum, target) => sum + target.amount, 0)) !== row.total ||
      row.targets.some((target) => !docById.has(target.id) || !saleIds.has(target.id)));
  const report = { gui: { count: gui.length, total: round(gui.reduce((sum, row) => sum + money(row.Valor), 0)) },
    live: { count: live.length, total: round(live.reduce((sum, row) => sum + Number(row.total || 0), 0)) },
    pages: pages.map((rows, index) => ({ page: index + 1, count: rows.length,
      firstDate: rows[0]?.fecha_emision, lastDate: rows.at(-1)?.fecha_emision })),
    uniqueAll: uniqueAll.size, uniqueLive: uniqueLive.size,
    archived: source.length, local: local.length,
    missingArchive: missing.length, missingLocal: live.filter((row) => !localIds.has(row.id)).length,
    missingIds: missing.map((row) => row.id),
    missingGui,
    missingByAccount: Object.entries(missingGui.flatMap((row) => row.accounts).reduce((acc, code) =>
      ({ ...acc, [code]: (acc[code] || 0) + 1 }), {})),
    changedArchive: live.filter((row) => archived.has(row.id) && archived.get(row.id).checksum !== checksum(row)).length,
    guiOnly: only(guiCounts, liveCounts).slice(0, 20), liveOnly: only(liveCounts, guiCounts).slice(0, 20),
    missingTargets: missingTargets.slice(0, 20), missingTargetsCount: missingTargets.length };
  if (reportFile) fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify(report, null, 2));
  if (uniqueAll.size !== all.length || uniqueLive.size !== live.length ||
    gui.length !== live.length || report.gui.total !== report.live.total ||
    report.guiOnly.length || report.liveOnly.length || missingTargets.length)
    process.exitCode = 2;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
