#!/usr/bin/env node
'use strict';
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { EJSON } = require('bson');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const { ContificoApi } = require('../services/contificoApi');
const { checksum, search } = require('./migrateContifico');

async function main() {
  const commit = process.argv.includes('--commit');
  const documentId = 'DGe7p2PmBcA9Alan';
  const journalId = 'pgenGvyZYH7Q7vaN';
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  const doc = await api.get(`/api/v2/documento/${documentId}/`);
  const journal = await api.get(`/api/v2/contabilidad/asiento/${journalId}/`);
  if (doc.tipo_registro !== 'PRO' || doc.tipo_documento !== 'FAC' || doc.fecha_emision !== '25/09/2026' ||
      doc.documento !== '002-202-000127596' || Number(doc.total) !== 2.85 || Number(doc.iva) !== 0.37 ||
      Number(doc.saldo) !== 2.85 || journal.fecha !== doc.fecha_emision || journal.glosa !== doc.descripcion ||
      !journal.detalles.some((line) => line.cuenta_id === 'RMdR77ROsv8vEel6' && line.tipo === 'H' && Number(line.valor) === 2.85))
    throw new Error('Factura o asiento cambió respecto a lo comprobado');
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const source = await Record.findOne({ clinic: clinic._id, entity: 'document', externalId: documentId }).lean();
  const journalSource = await Record.findOne({ clinic: clinic._id, entity: 'journal_entry', externalId: journalId }).lean();
  if (!source || journalSource) throw new Error('Estado de fuentes incompatible con la corrección');
  const report = { mode: commit ? 'COMMIT' : 'DRY_RUN', documentId, journalId,
    sourceLastModified: doc.fecha_modificacion, total: Number(doc.total), iva: Number(doc.iva), balance: Number(doc.saldo) };
  if (commit) {
    const folder = path.resolve(__dirname, '..', 'storage', 'contifico-batches');
    fs.mkdirSync(folder, { recursive: true });
    const backup = path.join(folder, `September-2026-late-invoice-before-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backup, EJSON.stringify(source, { relaxed: false }), { flag: 'wx' });
    await Record.updateOne({ _id: source._id }, { $set: {
      payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(doc)), { level: 9 }),
      payloadEncoding: 'gzip-json', checksum: checksum(doc), capturedAt: new Date(), search: search('document', doc),
    } });
    await Record.create({ clinic: clinic._id, entity: 'journal_entry', externalId: journalId,
      payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(journal)), { level: 9 }),
      payloadEncoding: 'gzip-json', checksum: checksum(journal), capturedAt: new Date(),
      search: search('journal_entry', journal),
      projection: { status: 'ARCHIVED', links: [], warnings: [] } });
    report.backup = backup;
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
