#!/usr/bin/env node
'use strict';

// Comparación de la instantánea de Contífico con las proyecciones propias.
// Sirve para validar una carga sin volver a consultar ni modificar Contífico.

require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const ContificoRecord = require('../models/ContificoRecord');
const ContificoMigrationRun = require('../models/ContificoMigrationRun');
const Sale = require('../models/Sale');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payment = require('../models/Payment');
const JournalEntry = require('../models/JournalEntry');
const Payroll = require('../models/Payroll');
const InventoryLayer = require('../models/InventoryLayer');
const CreditDebitNote = require('../models/CreditDebitNote');
const Product = require('../models/Product');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { parseDate } = require('./migrateContifico');

const amount = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
const round = (value) => +amount(value).toFixed(2);
const total = (rows, selector) => round(rows.reduce((sum, row) => sum + selector(row), 0));
const docTypes = new Set(['FAC', 'NVE', 'LQC', 'DNA', 'DAC', 'NCT']);

function args(argv) {
  const values = {};
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const at = arg.indexOf('=');
    if (at > 0) values[arg.slice(2, at)] = arg.slice(at + 1);
  }
  return { clinicName: values['clinic-name'] || 'Central', cutoff: parseDate(values.cutoff) || new Date() };
}

function comparison(source, target) {
  const result = { source, target, countMatch: source.count === target.count };
  if (Object.hasOwn(source, 'total')) {
    result.totalMatch = Math.abs(source.total - target.total) < 0.01;
    result.totalDelta = round(target.total - source.total);
  }
  return result;
}

async function main() {
  const options = args(process.argv.slice(2));
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: options.clinicName }).lean();
  if (!clinic) throw new Error(`Clinica no encontrada: ${options.clinicName}`);

  const snapshot = await ContificoMigrationRun.findOne({
    clinic: clinic._id,
    phase: 'EXTRACT',
    status: { $in: ['COMPLETED', 'COMPLETED_WITH_WARNINGS'] },
  }).sort({ completedAt: -1, createdAt: -1 }).lean();
  if (!snapshot) throw new Error('No existe una instantanea de extracción completada');

  const [dynamicRows, staticRows] = await Promise.all([
    ContificoRecord.find({ clinic: clinic._id, migrationRun: snapshot._id }).lean(),
    ContificoRecord.find({ clinic: clinic._id, entity: { $in: ['payroll_role', 'product_stock', 'product'] } }).lean(),
  ]);
  const rows = [...dynamicRows, ...staticRows];
  const byEntity = (entity) => rows
    .filter((row) => row.entity === entity)
    .map((row) => ({ ...row, payload: decodeCompressedJson(row.payloadCompressed) }));
  const documents = byEntity('document');
  const transactions = byEntity('transaction');
  const journals = byEntity('journal_entry');
  const roles = byEntity('payroll_role');
  const stock = byEntity('product_stock');
  const products = byEntity('product');
  const beforeCutoff = (row, field) => {
    const date = parseDate(row.payload[field]);
    return Boolean(date && date <= options.cutoff);
  };

  const sourceSales = documents.filter((row) =>
    String(row.payload.tipo_registro).toUpperCase() === 'CLI'
    && ['FAC', 'NVE'].includes(String(row.payload.tipo_documento).toUpperCase())
    && beforeCutoff(row, 'fecha_emision'));
  const sourcePurchases = documents.filter((row) =>
    String(row.payload.tipo_registro).toUpperCase() === 'PRO'
    && docTypes.has(String(row.payload.tipo_documento).toUpperCase())
    && beforeCutoff(row, 'fecha_emision'));
  const sourcePayments = transactions.filter((row) => {
    const payload = row.payload;
    const date = parseDate(payload.fecha_emision || payload.fecha);
    return ['C', 'P'].includes(String(payload.tipo_registro || payload.tipo).toUpperCase())
      && Boolean(date && date <= options.cutoff) && amount(payload.valor ?? payload.total) > 0;
  });
  const sourceJournals = journals.filter((row) => {
    const lines = row.payload.detalles || [];
    const debit = total(lines, (line) => String(line.tipo).toUpperCase() === 'D' ? amount(line.valor) : 0);
    const credit = total(lines, (line) => String(line.tipo).toUpperCase() === 'H' ? amount(line.valor) : 0);
    return beforeCutoff(row, 'fecha') && lines.length > 0 && Math.abs(debit - credit) < 0.01;
  });
  const sourceNotes = documents.filter((row) => ['NCT', 'DNA', 'DAC'].includes(String(row.payload.tipo_documento).toUpperCase())
    && String(row.payload.tipo_registro || '').toUpperCase() === 'CLI'
    && beforeCutoff(row, 'fecha_emision'));
  const sourceStockLines = stock.flatMap((row) => Array.isArray(row.payload.stock) ? row.payload.stock : []);

  const [nativeSales, nativePurchases, nativePayments, nativeJournals, nativePayroll, nativeStock, nativeNotes, nativeProducts] = await Promise.all([
    Sale.find({ clinic: clinic._id, idempotencyKey: /^contifico:/ }).select('total').lean(),
    PurchaseInvoice.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' }).select('total').lean(),
    Payment.find({ clinic: clinic._id, idempotencyKey: /^contifico:transaction:/ }).select('total').lean(),
    JournalEntry.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' }).select('totalDebit').lean(),
    Payroll.find({ clinic: clinic._id, code: /^CTF-ROL-/ }).select('totalNeto items').lean(),
    InventoryLayer.find({ clinic: clinic._id, sourceModel: 'ContificoStock' }).select('qtyInitial').lean(),
    CreditDebitNote.find({ clinic: clinic._id, sourceModel: 'ContificoRecord' }).select('total').lean(),
    Product.find({ clinic: clinic._id, code: { $in: products.map((row) => String(row.payload.codigo || '')).filter(Boolean) } }).select('stock').lean(),
  ]);

  const report = {
    clinic: clinic.name,
    snapshot: String(snapshot._id),
    cutoff: options.cutoff.toISOString(),
    comparisons: {
      sales: comparison({ count: sourceSales.length, total: total(sourceSales, (row) => amount(row.payload.total)) }, { count: nativeSales.length, total: total(nativeSales, (row) => amount(row.total)) }),
      purchases: comparison({ count: sourcePurchases.length, total: total(sourcePurchases, (row) => amount(row.payload.total)) }, { count: nativePurchases.length, total: total(nativePurchases, (row) => amount(row.total)) }),
      payments: comparison({ count: sourcePayments.length, total: total(sourcePayments, (row) => amount(row.payload.valor ?? row.payload.total)) }, { count: nativePayments.length, total: total(nativePayments, (row) => amount(row.total)) }),
      journals: comparison({ count: sourceJournals.length, total: total(sourceJournals, (row) => total(row.payload.detalles || [], (line) => String(line.tipo).toUpperCase() === 'D' ? amount(line.valor) : 0)) }, { count: nativeJournals.length, total: total(nativeJournals, (row) => amount(row.totalDebit)) }),
      payroll: {
        sourceRoles: roles.length,
        nativePayrollGroups: nativePayroll.length,
        nativePayrollItems: nativePayroll.reduce((count, row) => count + (row.items || []).length, 0),
        itemCountMatch: roles.length === nativePayroll.reduce((count, row) => count + (row.items || []).length, 0),
        sourceNet: total(roles, (row) => amount(row.payload.total_pago)),
        nativeNet: total(nativePayroll, (row) => amount(row.totalNeto)),
        totalMatch: Math.abs(total(roles, (row) => amount(row.payload.total_pago)) - total(nativePayroll, (row) => amount(row.totalNeto))) < 0.01,
      },
      warehouseStock: comparison({ count: sourceStockLines.length, total: total(sourceStockLines, (line) => amount(line.cantidad)) }, { count: nativeStock.length, total: total(nativeStock, (row) => amount(row.qtyInitial)) }),
      products: comparison({ count: products.length, total: total(products, (row) => amount(row.payload.cantidad_stock)) }, { count: nativeProducts.length, total: total(nativeProducts, (row) => amount(row.stock)) }),
      creditDebitNotes: comparison({ count: sourceNotes.length, total: total(sourceNotes, (row) => amount(row.payload.total)) }, { count: nativeNotes.length, total: total(nativeNotes, (row) => amount(row.total)) }),
    },
  };
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; }).finally(() => mongoose.disconnect().catch(() => {}));
