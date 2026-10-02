#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Account = require('../models/ChartOfAccount');
const Journal = require('../models/JournalEntry');
const Movement = require('../models/BankTransaction');
const Record = require('../models/ContificoRecord');
const Payment = require('../models/Payment');
const Purchase = require('../models/PurchaseInvoice');
const { decodeCompressedJson } = require('../utils/compressedJson');
const { readRows, money } = require('./auditContificoSeptemberBankExport');

const iso = (value) => value ? new Date(value).toISOString().slice(0, 10) : null;

async function main() {
  const file = process.argv[2];
  const rows = readRows(file);
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const accounts = await Account.find({ clinic: clinic._id,
    code: { $in: ['1.1.1.3', '1.1.1.4', '1.1.1.5'] } }).select('_id code').lean();
  const codeById = new Map(accounts.map((row) => [String(row._id), row.code]));
  const journals = await Journal.find({ clinic: clinic._id, number: {
    $in: ['CTF-Arb6YNV8Qsrxrzay', 'CTF-YWb4W0NY0TBGBgaZ'] } }).lean();
  const sourceRecords = await Record.find({ clinic: clinic._id, entity: 'journal_entry',
    externalId: { $in: journals.map((row) => row.number.replace(/^CTF-/, '')) } })
    .select('externalId search projection payloadCompressed').lean();
  const sourceById = new Map(sourceRecords.map((row) => [row.externalId, row]));
  const cheque = rows.find((row) => row['Numero de comprobante'] === '202609000024');
  const movement = await Movement.findOne({ clinic: clinic._id, reference: '202609000024' }).lean();
  const movementSource = movement?.sourceRef && await Record.findById(movement.sourceRef)
    .select('entity externalId search projection payloadCompressed').lean();
  const paymentRows = rows.filter((row) => money(row.Valor) === 675 &&
    row['Cuenta Bancaria'] === 'Banco Internacional');
  const relatedPayments = await Payment.find({ clinic: clinic._id, total: 675,
    date: { $gte: new Date('2026-09-01'), $lt: new Date('2026-11-01') } })
    .select('_id number date type total method reference bankAccount journalEntry applications').lean();
  const relatedPurchases = await Purchase.find({ clinic: clinic._id,
    serie: /000000572$/ }).select('_id serie fechaEmision total journalEntry sourceRef').lean();
  console.log(JSON.stringify({
    cheque: cheque && { date: cheque.Fecha, checkDate: cheque['Fecha de Cheque'],
      checkNumber: cheque['Numero de cheque'], voucher: cheque['Numero de comprobante'],
      value: cheque.Valor, description: cheque.Descripcion },
    movement: movement && { date: iso(movement.date), amount: movement.amount,
      direction: movement.direction, type: movement.type, reference: movement.reference,
      journalEntry: movement.journalEntry, sourceRef: movement.sourceRef },
    movementSource: movementSource && { entity: movementSource.entity,
      externalId: movementSource.externalId, search: movementSource.search,
      projection: movementSource.projection, payload: decodeCompressedJson(movementSource.payloadCompressed) },
    journalExceptions: journals.map((row) => ({ number: row.number, date: iso(row.date),
      description: row.description, sourceModel: row.sourceModel, sourceRef: row.sourceRef,
      lines: row.lines.map((line) => ({ account: codeById.get(String(line.account)) || line.accountCode,
        debit: line.debit, credit: line.credit, description: line.description })),
      source: sourceById.get(row.number.replace(/^CTF-/, '')) && {
        externalId: sourceById.get(row.number.replace(/^CTF-/, '')).externalId,
        search: sourceById.get(row.number.replace(/^CTF-/, '')).search,
        projection: sourceById.get(row.number.replace(/^CTF-/, '')).projection,
        payload: decodeCompressedJson(sourceById.get(row.number.replace(/^CTF-/, '')).payloadCompressed),
      } })),
    guiInternational675: paymentRows,
    relatedPayments: relatedPayments.map((row) => ({ ...row, date: iso(row.date) })),
    relatedPurchases,
  }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
