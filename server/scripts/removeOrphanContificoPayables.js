#!/usr/bin/env node
'use strict';

// Retira exclusivamente saldos CxP cuyo documento fue retirado de una
// instantánea completa y cuya consulta directa confirma que ya no existe.
// Uso: node scripts/removeOrphanContificoPayables.js [--commit]
require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const Clinic = require('../models/Clinic');
const ContificoRecord = require('../models/ContificoRecord');
const Payable = require('../models/Payable');
const { ContificoApi } = require('../services/contificoApi');

const ids = ['BleXLP8xVHX3X2er', 'y7aANPr6PUNMN4bg'];

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  const candidates = [];
  for (const id of ids) {
    const record = await ContificoRecord.findOne({ clinic: clinic._id, entity: 'document', externalId: id }).lean();
    if (!record || record.projection?.status !== 'REVIEW' ||
        !(record.projection?.warnings || []).some((warning) => warning.startsWith('Ausente de la instantánea Contífico '))) {
      throw new Error(`${id}: falta la evidencia archivada de retiro`);
    }
    const payable = await Payable.findOne({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id }).lean();
    if (!payable) throw new Error(`${id}: CxP ya ausente`);
    try {
      await api.get(`/api/v2/documento/${encodeURIComponent(id)}/`);
      throw new Error(`${id}: documento todavía existe en la API; operación detenida`);
    } catch (error) {
      if (error.status !== 400 || !error.message.includes('Documento no encontrado.')) throw error;
    }
    candidates.push({ id, record, payable });
  }
  const report = { mode: commit ? 'COMMIT' : 'DRY_RUN', candidates: candidates.map(({ id, payable }) => ({
    id, payableId: String(payable._id), total: payable.total, balance: payable.balance,
  })), balanceRemoved: +candidates.reduce((sum, row) => sum + row.payable.balance, 0).toFixed(2) };
  if (commit) {
    const directory = path.resolve(__dirname, '..', 'storage', 'contifico-backups');
    fs.mkdirSync(directory, { recursive: true });
    const backup = path.join(directory, `orphan-payables-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    const body = EJSON.stringify({ report, payables: candidates.map((row) => row.payable) }, { relaxed: false });
    fs.writeFileSync(backup, body, { flag: 'wx' });
    report.backup = backup;
    report.backupSha256 = crypto.createHash('sha256').update(body).digest('hex');
    for (const { payable } of candidates) {
      const result = await Payable.deleteOne({ _id: payable._id, clinic: clinic._id,
        sourceModel: 'ContificoRecord', sourceRef: payable.sourceRef, balance: payable.balance });
      if (result.deletedCount !== 1) throw new Error(`No se retiró CxP ${payable._id}`);
    }
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
