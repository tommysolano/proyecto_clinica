#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const Record = require('../models/ContificoRecord');
const Purchase = require('../models/PurchaseInvoice');
const { ContificoApi } = require('../services/contificoApi');
const { decodeCompressedJson } = require('../utils/compressedJson');

async function main() {
  const id = 'DGe7p2PmBcA9Alan';
  const api = new ContificoApi({ apiKey: process.env.CONTIFICO_API_KEY, retries: 0, timeoutMs: 20000 });
  const live = await api.get(`/api/v2/documento/${id}/`);
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  const record = await Record.findOne({ clinic: clinic._id, entity: 'document', externalId: id }).lean();
  const local = await Purchase.findOne({ clinic: clinic._id, sourceModel: 'ContificoRecord', sourceRef: record._id }).lean();
  const archived = decodeCompressedJson(record.payloadCompressed);
  const journals = [];
  for await (const page of api.pages('/api/v2/contabilidad/asiento/',
    { fecha_inicial: live.fecha_emision, fecha_final: live.fecha_emision }, 100, {}))
    journals.push(...page.rows.filter((row) => String(row.glosa || '').trim() === String(live.descripcion || '').trim()));
  console.log(JSON.stringify({ live: { id, fecha: live.fecha_emision, creado: live.fecha_creacion,
    modificado: live.fecha_modificacion, numero: live.documento, descripcion: live.descripcion,
    total: live.total, iva: live.iva, saldo: live.saldo, detalles: live.detalles },
  archived: { total: archived.total, iva: archived.iva, saldo: archived.saldo,
    modificado: archived.fecha_modificacion, capturedAt: record.capturedAt },
  local: { total: local.total, iva: local.iva, balance: local.balance, journalEntry: local.journalEntry },
  journals: journals.map((row) => ({ id: row.id, fecha: row.fecha, glosa: row.glosa, detalles: row.detalles })) }, null, 2));
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
