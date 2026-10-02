#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const zlib = require('zlib');
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Sale = require('../models/Sale');
const Payment = require('../models/Payment');
const Journal = require('../models/JournalEntry');
const Account = require('../models/ChartOfAccount');
const Bank = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const { ContificoApi } = require('../services/contificoApi');
const { checksum, search } = require('./migrateContifico');
const { SupplementalProjector } = require('./projectContificoSupplemental');

const coverageFile = process.argv.find((arg) => arg.startsWith('--coverage='))?.slice('--coverage='.length);
const journalFile = process.argv.find((arg) => arg.startsWith('--journals='))?.slice('--journals='.length);
const commit = process.argv.includes('--commit');
const round = (value) => +Number(value || 0).toFixed(2);

async function main() {
  if (!coverageFile || !journalFile) throw new Error('Faltan --coverage o --journals');
  const coverage = JSON.parse(fs.readFileSync(coverageFile, 'utf8'));
  const proof = JSON.parse(fs.readFileSync(journalFile, 'utf8'));
  const ids = new Set(coverage.missingIds);
  if (ids.size !== 55 || coverage.gui?.count !== 2390 || coverage.live?.count !== 2390 ||
    coverage.gui?.total !== 110116.84 || coverage.live?.total !== 110116.84 ||
    coverage.changedArchive || coverage.guiOnly?.length || coverage.liveOnly?.length ||
    coverage.missingTargetsCount || proof.sourceMissing !== 55 || proof.liveFound !== 55 ||
    proof.zeroMatches || proof.allMatches?.length !== 55)
    throw new Error('Los informes independientes de septiembre no están completos');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 1, timeoutMs: 20000 });
  const live = (await api.listV1('/api/v1/registro/transaccion/',
    { result_size: 1000, result_page: 1 })).filter((row) => ids.has(row.id));
  if (live.length !== 55 || new Set(live.map((row) => row.id)).size !== 55 ||
    live.some((row) => row.tipo !== 'C' || row.fecha_emision !== '30/09/2026'))
    throw new Error('Las 55 transacciones ya no están completas en el origen');
  const sourceDocs = await Record.find({ clinic: clinic._id, entity: 'document',
    externalId: { $in: [...new Set(live.flatMap((row) => [row.documento_id,
      ...(row.detalles || []).map((item) => item.documento_id)].filter(Boolean)))] } })
    .select('externalId').lean();
  const docIds = new Set(sourceDocs.map((row) => row.externalId));
  const sales = await Sale.find({ clinic: clinic._id,
    idempotencyKey: { $in: [...docIds].map((id) => `contifico:${id}`) } })
    .select('idempotencyKey').lean();
  const saleIds = new Set(sales.map((row) => row.idempotencyKey.slice('contifico:'.length)));
  for (const row of live) {
    const targets = (row.detalles || []).filter((item) => round(item.valor_pago) > 0 && item.documento_id)
      .map((item) => ({ id: item.documento_id, amount: round(item.valor_pago) }));
    if (!targets.length && row.documento_id) targets.push({ id: row.documento_id, amount: round(row.total) });
    if (round(targets.reduce((sum, item) => sum + item.amount, 0)) !== round(row.total) ||
      targets.some((item) => !docIds.has(item.id) || !saleIds.has(item.id)))
      throw new Error(`${row.id}: aplicación a venta sin respaldo`);
  }
  const guiById = new Map(coverage.missingGui.map((row) => [row.id, row]));
  const proofById = new Map(proof.allMatches.map((row) => [row.id, row]));
  if (guiById.size !== 55 || proofById.size !== 55) throw new Error('Manifest duplicado o incompleto');
  const codes = [...new Set(coverage.missingGui.flatMap((row) => row.accounts))];
  const accounts = await Account.find({ clinic: clinic._id, code: { $in: codes } }).select('_id code').lean();
  const accountByCode = new Map(accounts.map((row) => [row.code, row]));
  const banks = await Bank.find({ clinic: clinic._id }).select('_id chartAccount').lean();
  const bankByAccount = new Map(banks.map((row) => [String(row.chartAccount), row]));
  const unique = proof.allMatches.filter((row) => row.journalCount === 1);
  const journals = await Journal.find({ clinic: clinic._id,
    number: { $in: unique.map((row) => `CTF-${row.journalId}`) } }).select('_id number').lean();
  const journalById = new Map(journals.map((row) => [row.number.slice(4), row]));
  if (unique.length !== 37 || journalById.size !== 37 ||
    new Set(unique.map((row) => row.journalId)).size !== 37)
    throw new Error('Los 37 asientos individuales no tienen correspondencia única');
  for (const row of live) {
    const gui = guiById.get(row.id), evidence = proofById.get(row.id);
    if (!gui || gui.accounts?.length !== 1 || gui.guiRows < 1 || !evidence ||
      evidence.total !== round(row.total) || evidence.sourceDocumentId !==
      (row.documento_id || row.detalles?.[0]?.documento_id || null))
      throw new Error(`${row.id}: comprobación GUI/asiento cambió`);
    const code = gui.accounts[0];
    if (!accountByCode.has(code)) throw new Error(`${row.id}: cuenta afectada desconocida ${code}`);
    if (code.startsWith('1.1.1.3') || code.startsWith('1.1.1.4') || code.startsWith('1.1.1.5')) {
      if (!bankByAccount.has(String(accountByCode.get(code)._id)))
        throw new Error(`${row.id}: falta banco para ${code}`);
    }
  }
  const existing = await Record.countDocuments({ clinic: clinic._id, entity: 'transaction',
    externalId: { $in: [...ids] } });
  const localBefore = await Payment.countDocuments({ clinic: clinic._id, type: 'COBRO',
    idempotencyKey: { $in: [...ids].map((id) => `contifico:transaction:${id}`) } });
  const ledgerBefore = await Journal.countDocuments({ clinic: clinic._id });
  const bankMovementsBefore = await BankTransaction.countDocuments({ clinic: clinic._id });
  if (existing !== 0 && existing !== 55) throw new Error(`Archivo parcialmente creado: ${existing}`);
  if (localBefore !== 0 && localBefore !== 55) throw new Error(`Cobros parcialmente creados: ${localBefore}`);
  const summary = { mode: commit ? 'COMMIT' : 'DRY_RUN', expectedCobros: 55,
    total: round(live.reduce((sum, row) => sum + Number(row.total), 0)),
    archivedBefore: existing, localBefore, uniqueJournalLinks: unique.length,
    ambiguousJournalLinks: 55 - unique.length,
    bankAccounts: coverage.missingGui.filter((row) =>
      ['1.1.1.3', '1.1.1.4', '1.1.1.5'].includes(row.accounts[0])).length };
  if (commit) {
    const now = new Date();
    await Record.bulkWrite(live.map((payload) => ({ updateOne: {
      filter: { clinic: clinic._id, entity: 'transaction', externalId: payload.id },
      update: { $set: { payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(payload)), { level: 9 }),
        payloadEncoding: 'gzip-json', checksum: checksum(payload), capturedAt: now,
        search: search('transaction', payload) },
      $setOnInsert: { clinic: clinic._id, entity: 'transaction', externalId: payload.id,
        projection: { status: 'ARCHIVED', links: [], warnings: [] } } }, upsert: true,
    } })), { ordered: false });
    const projector = new SupplementalProjector({ clinic, commit: true, cutoff: now,
      only: new Set(['transactions']), sourceIds: ids });
    await projector.initialize();
    await projector.transactions();
    const projected = await Payment.find({ clinic: clinic._id, type: 'COBRO',
      idempotencyKey: { $in: [...ids].map((id) => `contifico:transaction:${id}`) } }).lean();
    const byId = new Map(projected.map((row) => [row.idempotencyKey.slice('contifico:transaction:'.length), row]));
    if (byId.size !== 55) throw new Error(`Solo ${byId.size}/55 cobros proyectados`);
    for (const row of live) {
      const projectedRow = byId.get(row.id);
      if (round(projectedRow.total) !== round(row.total) ||
        round(projectedRow.appliedAmount) !== round(row.total) ||
        round(projectedRow.advanceAmount) !== 0 || !projectedRow.applications.length)
        throw new Error(`${row.id}: cobro proyectado sin aplicación exacta`);
    }
    await Payment.bulkWrite(live.map((row) => {
      const gui = guiById.get(row.id), evidence = proofById.get(row.id);
      const account = accountByCode.get(gui.accounts[0]);
      const bank = bankByAccount.get(String(account._id));
      const fields = {};
      if (bank) fields.bankAccount = bank._id;
      if (evidence.journalCount === 1) fields.journalEntry = journalById.get(evidence.journalId)._id;
      return { updateOne: { filter: { _id: byId.get(row.id)._id }, update: { $set: fields } } };
    }), { ordered: false });
    const [ledgerAfter, bankMovementsAfter] = await Promise.all([
      Journal.countDocuments({ clinic: clinic._id }), BankTransaction.countDocuments({ clinic: clinic._id }),
    ]);
    if (ledgerAfter !== ledgerBefore || bankMovementsAfter !== bankMovementsBefore)
      throw new Error('El lote alteró el diario o creó movimientos bancarios');
    summary.projected = 55; summary.ledgerUnchanged = true; summary.bankMovementsUnchanged = true;
  }
  console.log(JSON.stringify(summary, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
