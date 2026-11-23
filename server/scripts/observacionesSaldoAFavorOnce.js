#!/usr/bin/env node
/**
 * OBSERVACIONES CON SALDO A FAVOR — UNA SOLA VEZ (nov-2026).
 *
 * La constancia automática de cada compra («Compra · fecha / ítems / Total») no decía que el
 * paciente pagó de más ni que pagó con su saldo. Desde ahora lo dice (utils/observacionesAutomaticas);
 * esta tarea reescribe las constancias de las ventas que ya existían con saldo a favor
 * (excedente o pago con «anticipo") conservando su fecha original.
 *
 *   node scripts/observacionesSaldoAFavorOnce.js            (DRY-RUN: solo cuenta)
 *   node scripts/observacionesSaldoAFavorOnce.js --commit   (reescribe una vez y deja marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');
const OneTimeTask = require('../models/OneTimeTask');
const Sale = require('../models/Sale');

const TASK_KEY = 'observaciones-saldo-a-favor-2026-11-23';

async function ventas() {
  return Sale.find({
    patient: { $ne: null },
    $or: [{ advanceCreated: { $gt: 0.005 } }, { 'payments.method': 'anticipo' }],
  }).select('_id saleNumber createdBy').lean();
}

async function main() {
  const commit = process.argv.includes('--commit');
  await connect();
  try {
    const lista = await ventas();
    console.log(`Ventas con saldo a favor: ${lista.length}`);
    if (!commit) return;
    const previa = await OneTimeTask.findById(TASK_KEY).lean();
    if (previa?.status === 'DONE') { console.log(`⏭️  "${TASK_KEY}" ya ejecutada.`); return; }
    const marca = { status: 'RUNNING', host: os.hostname(), pid: process.pid, startedAt: new Date(), finishedAt: null, error: '', result: null };
    if (previa) await OneTimeTask.updateOne({ _id: TASK_KEY }, { $set: marca, $inc: { attempts: 1 } });
    else await OneTimeTask.create({ _id: TASK_KEY, ...marca, attempts: 1 });
    try {
      const { registrarVenta } = require('../utils/observacionesAutomaticas');
      for (const v of lista) {
        // eslint-disable-next-line no-await-in-loop
        await registrarVenta(v._id, v.createdBy, { fechaOriginal: true, lanzar: true });
      }
      await OneTimeTask.updateOne({ _id: TASK_KEY }, { $set: { status: 'DONE', finishedAt: new Date(), result: { reescritas: lista.length } } });
      console.log(`🔒  ${lista.length} observaciones reescritas; marca "${TASK_KEY}" = DONE.`);
    } catch (e) {
      await OneTimeTask.updateOne({ _id: TASK_KEY }, { $set: { status: 'FAILED', finishedAt: new Date(), error: e.message } });
      throw e;
    }
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
