#!/usr/bin/env node
'use strict';
const fs = require('fs');
const { parse } = require('csv-parse/sync');

const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
if (!input) throw new Error('Falta --input=archivo');
const records = parse(fs.readFileSync(input, 'utf8'), { delimiter: '\t', columns: true,
  relax_quotes: true, relax_column_count: true, skip_empty_lines: true });
const amount = (value) => Number(String(value || '').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')) || 0;
const freq = (rows, key) => Object.entries(rows.reduce((result, row) => {
  const value = String(row[key] || '(vacío)').trim() || '(vacío)';
  if (!result[value]) result[value] = { count: 0, total: 0 };
  result[value].count += 1; result[value].total += amount(row.Valor);
  return result;
}, {})).map(([label, stat]) => ({ label, count: stat.count, total: +stat.total.toFixed(2) }))
  .sort((a, b) => b.count - a.count);
const rows = records.filter((row) => /^\d{2}\/09\/2026$/.test(row.Fecha));
const pagos = rows.filter((row) => row.Tipo === 'Pago');
const report = { parsedRows: records.length, septemberRows: rows.length, payments: pagos.length,
  paymentsTotal: +pagos.reduce((sum, row) => sum + amount(row.Valor), 0).toFixed(2),
  byType: freq(rows, 'Tipo'), byPaymentMethod: freq(pagos, 'Forma Cobro/Pago'),
  byAffectedAccount: freq(pagos, 'Código Cta Afectada'), byPerson: freq(pagos, 'Persona').slice(0, 30),
  paymentsSample: pagos.slice(0, 25).map((row) => ({ date: row.Fecha, id: row['Identificación'],
    person: row.Persona, method: row['Forma Cobro/Pago'], voucher: row['#Comprobante'],
    account: row['Código Cta Afectada'], document: row['Documento Cruce'], amount: amount(row.Valor),
    description: row['Descripción'] })) };
if (!process.argv.includes('--db')) console.log(JSON.stringify(report, null, 2));
else {
  require('dotenv').config();
  const mongoose = require('mongoose');
  const Clinic = require('../models/Clinic');
  const Record = require('../models/ContificoRecord');
  const Payment = require('../models/Payment');
  const BankTransaction = require('../models/BankTransaction');
  const { decodeCompressedJson } = require('../utils/compressedJson');
  (async () => {
    await mongoose.connect(process.env.MONGODB_URI);
    const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
    const from = new Date('2026-09-01T00:00:00Z'), through = new Date('2026-10-01T00:00:00Z');
    const sourceRows = await Record.find({ clinic: clinic._id, entity: 'transaction',
      'search.date': { $gte: from, $lt: through }, 'search.type': 'P' }).lean();
    const source = sourceRows.map((row) => ({ id: row.externalId,
      payload: decodeCompressedJson(row.payloadCompressed), projection: row.projection }));
    const local = await Payment.find({ clinic: clinic._id, type: 'PAGO', date: { $gte: from, $lt: through } }).lean();
    const banks = await BankTransaction.find({ clinic: clinic._id, date: { $gte: from, $lt: through },
      direction: -1 }).lean();
    console.log(JSON.stringify({ gui: { count: pagos.length, total: report.paymentsTotal },
      archived: { count: source.length, total: +source.reduce((sum, row) => sum + Number(row.payload.total || 0), 0).toFixed(2),
        rows: source.map((row) => ({ id: row.id, fecha: row.payload.fecha_emision,
          persona_id: row.payload.persona_id, total: row.payload.total, forma: row.payload.forma,
          comprobante: row.payload.numero_comprobante, detalles: row.payload.detalles,
          projection: row.projection?.status })) },
      local: { count: local.length, total: +local.reduce((sum, row) => sum + Number(row.total || 0), 0).toFixed(2),
        rows: local.map((row) => ({ id: String(row._id), date: row.date, number: row.number,
          total: row.total, method: row.method, partyId: row.partyId, reference: row.reference,
          idempotencyKey: row.idempotencyKey, applications: row.applications,
          bankTransaction: row.bankTransaction, journalEntry: row.journalEntry })) },
      bankOutflows: { count: banks.length, total: +banks.reduce((sum, row) => sum + Number(row.amount || 0), 0).toFixed(2),
        rows: banks.map((row) => ({ id: String(row._id), date: row.date, amount: row.amount,
          bankAccount: String(row.bankAccount), reference: row.reference, voucherNumber: row.voucherNumber,
          description: row.description, sourceModel: row.sourceModel, sourceRef: row.sourceRef })) } }, null, 2));
  })().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
    .finally(() => mongoose.disconnect().catch(() => {}));
}
