#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const { parse } = require('csv-parse/sync');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Payment = require('../models/Payment');
const Purchase = require('../models/PurchaseInvoice');
const Journal = require('../models/JournalEntry');
const Account = require('../models/ChartOfAccount');
const Bank = require('../models/BankAccount');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

const input = process.argv.find((arg) => arg.startsWith('--input='))?.slice('--input='.length);
const reportFile = process.argv.find((arg) => arg.startsWith('--report='))?.slice('--report='.length);
const verifyLocal = process.argv.includes('--verify-local');
const newIds = ['Ejb2Rn13JUpAp1bV', 'mBdJZV752hqPqZd0', 'BXdLgX5oAuR5RKbJ', '9jaKOWAVMT202Oak'];
const money = (value) => +Number(String(value || '0').replace(/[^\d,.-]/g, '').replace(/\./g, '').replace(',', '.')).toFixed(2);
const round = (value) => +Number(value || 0).toFixed(2);
const normalize = (value) => String(value || '').replace(/\s+/g, ' ').trim().toUpperCase();

async function main() {
  if (!input) throw new Error('Falta --input');
  const gui = parse(fs.readFileSync(input, 'utf8'), { delimiter: '\t', columns: true,
    relax_quotes: true, relax_column_count: true, skip_empty_lines: true })
    .filter((row) => row.Tipo === 'Pago' && /^\d{2}\/09\/2026$/.test(row.Fecha));
  if (gui.length !== 17) throw new Error(`Se esperaban 17 filas de Pago: ${gui.length}`);
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const archived = await Record.find({ clinic: clinic._id, entity: 'transaction',
    'search.date': { $gte: new Date('2026-09-01'), $lt: new Date('2026-10-01') }, 'search.type': 'P' }).lean();
  if (![13, 17].includes(archived.length)) throw new Error(`Archivo de transacciones inesperado: ${archived.length}`);
  const ids = [...new Set([...archived.map((row) => row.externalId), ...newIds])];
  const live = [];
  for (let i = 0; i < ids.length; i += 5) {
    live.push(...await Promise.all(ids.slice(i, i + 5).map((id) => api.get(`/api/v1/registro/transaccion/${id}/`))));
  }
  const people = await Record.find({ clinic: clinic._id, entity: 'person',
    externalId: { $in: [...new Set(live.map((row) => row.persona_id))] } }).lean();
  const personById = new Map(people.map((row) => [row.externalId, decodeCompressedJson(row.payloadCompressed)]));
  const documentIds = [...new Set(live.flatMap((row) => [row.documento_id,
    ...(row.detalles || []).map((detail) => detail.documento_id)].filter(Boolean)))];
  const docSources = await Record.find({ clinic: clinic._id, entity: 'document',
    externalId: { $in: documentIds } }).lean();
  const sourceDocById = new Map(docSources.map((row) => [row.externalId, row]));
  const purchases = await Purchase.find({ clinic: clinic._id, sourceModel: 'ContificoRecord',
    sourceRef: { $in: docSources.map((row) => row._id) } }).lean();
  const purchaseByRef = new Map(purchases.map((row) => [String(row.sourceRef), row]));
  const local = await Payment.find({ clinic: clinic._id, idempotencyKey: { $in: ids.map((id) => `contifico:transaction:${id}`) } }).lean();
  const paymentById = new Map(local.map((row) => [row.idempotencyKey.slice('contifico:transaction:'.length), row]));
  const accountRecords = await api.listV1('/api/v1/contabilidad/cuenta-contable/');
  const sourceAccountByCode = new Map(accountRecords.map((row) => [row.codigo, row.id]));
  const localAccounts = await Account.find({ clinic: clinic._id }).select('_id code').lean();
  const localAccountByCode = new Map(localAccounts.map((row) => [row.code, row]));
  const banks = await Bank.find({ clinic: clinic._id }).lean();
  const bankByAccount = new Map(banks.map((row) => [String(row.chartAccount), row]));
  const dates = [...new Set(gui.map((row) => row.Fecha))].sort();
  const journals = [];
  for (const date of dates) {
    for await (const page of api.pages('/api/v2/contabilidad/asiento/',
      { fecha_inicial: date, fecha_final: date }, 100, {})) journals.push(...page.rows);
  }
  const journalIds = [...new Set(journals.map((row) => `CTF-${row.id}`))];
  const localJournals = await Journal.find({ clinic: clinic._id, number: { $in: journalIds } }).lean();
  const localJournalById = new Map(localJournals.map((row) => [row.number.slice(4), row]));
  const matches = [], issues = [], usedGui = new Set(), usedJournal = new Set();
  for (const row of live) {
    const person = personById.get(row.persona_id);
    const identification = String(person?.ruc || person?.cedula || '');
    const candidates = gui.filter((screen) => !usedGui.has(screen) && screen.Fecha === row.fecha_emision &&
      money(screen.Valor) === round(row.total) && screen['#Comprobante'] === row.numero_comprobante &&
      screen['Identificación'] === identification);
    if (candidates.length !== 1) { issues.push({ id: row.id, kind: 'GUI_MATCH', count: candidates.length,
      date: row.fecha_emision, total: round(row.total), voucher: row.numero_comprobante, identification }); continue; }
    const screen = candidates[0]; usedGui.add(screen);
    const bankCode = screen['Código Cta Afectada'];
    const cross = row.numero_comprobante === 'Cruce de documento' && !row.forma;
    const expectedMethod = cross ? 'OTRO' : row.forma === 'CAJA CHICA' ? 'EFECTIVO' :
      row.forma === 'TRANSF' ? 'TRANSFERENCIA' : row.forma === 'CHEQUE' ? 'CHEQUE' : 'OTRO';
    const entries = (row.detalles || []).filter((detail) => round(detail.valor_pago) > 0);
    const direct = entries.filter((detail) => detail.documento_id);
    const targets = direct.length ? direct.map((detail) => ({ id: detail.documento_id, amount: round(detail.valor_pago) })) :
      row.documento_id ? [{ id: row.documento_id, amount: round(row.total) }] : [];
    if (round(targets.reduce((sum, item) => sum + item.amount, 0)) !== round(row.total))
      issues.push({ id: row.id, kind: 'APPLICATION_SUM', targets, total: row.total });
    const applications = targets.map((target) => ({ ...target,
      number: sourceDocById.get(target.id) && decodeCompressedJson(sourceDocById.get(target.id).payloadCompressed).documento,
      localPurchase: purchaseByRef.get(String(sourceDocById.get(target.id)?._id))?._id || null }));
    if (applications.some((item) => !item.localPurchase)) issues.push({ id: row.id, kind: 'PURCHASE_MISSING', applications });
    const localPayment = paymentById.get(row.id);
    const bank = bankByAccount.get(String(localAccountByCode.get(bankCode)?._id));
    const creditCode = cross ? '1.1.4.3' : bankCode;
    const debitPayable = sourceAccountByCode.get('2.1.3.1.1');
    const credit = sourceAccountByCode.get(creditCode);
    const possibleJournals = journals.filter((entry) => !usedJournal.has(entry.id) && entry.fecha === row.fecha_emision &&
      normalize(entry.glosa) === normalize(screen['Descripción']) &&
      entry.detalles?.some((line) => line.cuenta_id === debitPayable && line.tipo === 'D' && round(line.valor) === round(row.total)) &&
      entry.detalles?.some((line) => line.cuenta_id === credit && line.tipo === 'H' && round(line.valor) === round(row.total)));
    if (possibleJournals.length !== 1) issues.push({ id: row.id, kind: 'JOURNAL_MATCH', count: possibleJournals.length,
      date: row.fecha_emision, total: round(row.total), description: screen['Descripción'] });
    const journal = possibleJournals[0]; if (journal) usedJournal.add(journal.id);
    const localJournal = journal && localJournalById.get(journal.id);
    if (!localJournal) issues.push({ id: row.id, kind: 'LOCAL_JOURNAL_MISSING', journalId: journal?.id });
    const expectedApps = applications.map((item) => `${item.localPurchase}:${item.amount}`).sort();
    const actualApps = (localPayment?.applications || []).map((item) => `${item.docRef}:${round(item.amount)}`).sort();
    matches.push({ id: row.id, date: row.fecha_emision, identification, total: round(row.total),
      voucher: row.numero_comprobante, sourceMethod: row.forma, expectedMethod, cross,
      affectedAccount: bankCode, bankId: bank ? String(bank._id) : null,
      journalId: journal?.id || null, localJournalId: localJournal ? String(localJournal._id) : null,
      localPaymentId: localPayment ? String(localPayment._id) : null,
      localMethod: localPayment?.method || null,
      localBankId: localPayment?.bankAccount ? String(localPayment.bankAccount) : null,
      localJournalLink: localPayment?.journalEntry ? String(localPayment.journalEntry) : null,
      applications: applications.map((item) => ({ id: item.id, number: item.number,
        amount: item.amount, localPurchase: item.localPurchase ? String(item.localPurchase) : null })),
      localApplicationsMatch: localPayment ? JSON.stringify(expectedApps) === JSON.stringify(actualApps) : false });
    if (verifyLocal && (!localPayment || localPayment.method !== expectedMethod ||
      String(localPayment.journalEntry || '') !== String(localJournal?._id || '') ||
      String(localPayment.bankAccount || '') !== String(bank?._id || '') ||
      JSON.stringify(expectedApps) !== JSON.stringify(actualApps) ||
      round(localPayment.appliedAmount) !== round(row.total) || round(localPayment.advanceAmount) !== 0))
      issues.push({ id: row.id, kind: 'LOCAL_PAYMENT_MISMATCH' });
    if (!cross && row.forma !== 'CAJA CHICA' && !bank) issues.push({ id: row.id, kind: 'BANK_MAPPING_MISSING', bankCode });
  }
  const report = { guiRows: gui.length, sourceRows: live.length, matchedGui: usedGui.size,
    total: round(live.reduce((sum, row) => sum + Number(row.total), 0)),
    localPayments: local.length, localTotal: round(local.reduce((sum, row) => sum + Number(row.total), 0)),
    matches, issues };
  console.log(JSON.stringify(report, null, 2));
  if (reportFile && !issues.length && usedGui.size === gui.length)
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  if (issues.length || usedGui.size !== gui.length) process.exitCode = 2;
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
