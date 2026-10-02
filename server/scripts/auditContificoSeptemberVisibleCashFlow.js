#!/usr/bin/env node
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Clinic = require('../models/Clinic');
const CashFlowConfig = require('../models/CashFlowConfig');
const JournalEntry = require('../models/JournalEntry');
const svc = require('../services/cashFlowService');

const round = (value) => +Number(value || 0).toFixed(2);

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const clinic = await Clinic.findOne({ name: /^Central$/i }).lean();
  if (!clinic) throw new Error('Clínica Central no encontrada');
  const cfg = await CashFlowConfig.findOne({ clinic: clinic._id }).lean();
  if (!cfg) throw new Error('No existe configuración del flujo de caja; se evita crearla durante la auditoría');
  const from = '2026-09-01', to = '2026-09-30';
  const data = await svc.buildProjection(clinic._id, { from, to });
  const real = data.detalle.filter((row) => row.esReal && !row.transferenciaInterna);
  const realIn = round(real.filter((row) => row.direction === 'INGRESO').reduce((sum, row) => sum + Number(row.total || 0), 0));
  const realOut = round(real.filter((row) => row.direction === 'EGRESO').reduce((sum, row) => sum + Number(row.total || 0), 0));
  const resolved = await svc.resolveCashAccounts(clinic._id, cfg);
  const ids = resolved.ids;
  const gl = await JournalEntry.aggregate([
    { $match: { clinic: clinic._id, status: 'CONTABILIZADO', date: { $lt: new Date('2026-10-01T05:00:00Z') },
      'lines.account': { $in: ids } } },
    { $unwind: '$lines' },
    { $match: { 'lines.account': { $in: ids } } },
    { $group: { _id: null, debit: { $sum: '$lines.debit' }, credit: { $sum: '$lines.credit' } } },
  ]);
  const ledgerClosing = round(Number(gl[0]?.debit || 0) - Number(gl[0]?.credit || 0));
  const result = {
    range: `${from}..${to}`,
    mode: data.config.openingBalanceMode,
    cashAccounts: resolved.accounts.map((row) => row.code),
    days: data.days.length,
    opening: data.saldoInicial,
    closingIncludingProjection: data.saldoFinal,
    realMovements: real.length,
    realIn,
    realOut,
    realNet: round(realIn - realOut),
    projectedIn: round(data.days.reduce((sum, day) => sum + day.ingresosProyectados, 0)),
    projectedOut: round(data.days.reduce((sum, day) => sum + day.egresosProyectados, 0)),
    internalTransfers: data.totales.transferenciasInternas,
    ledgerClosing,
    realOnlyClosing: round(data.saldoInicial + realIn - realOut),
    sourceDetails: data.detalle.length,
    highSeverityAlerts: data.alertas.filter((row) => row.severidad === 'alta').map((row) => ({ type: row.tipo, value: row.valor })),
  };
  result.realOnlyMatchesLedger = result.realOnlyClosing === ledgerClosing;
  console.log(JSON.stringify(result, null, 2));
  if (!result.realOnlyMatchesLedger) process.exitCode = 2;
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; })
  .finally(() => mongoose.disconnect().catch(() => {}));
