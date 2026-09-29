#!/usr/bin/env node
/**
 * RELLENA LAS OBSERVACIONES AUTOMÁTICAS CON LO QUE YA PASÓ — UNA SOLA VEZ.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * Desde sep-2026 la bitácora de Observaciones del paciente se escribe sola: cada cita
 * atendida (servicios, quién atendió, valor o canje, adelanto, quién registró el cobro)
 * y cada venta (qué se llevó, total, forma de pago, quién cobró). Ver
 * utils/observacionesAutomaticas.js. Sin este relleno, la ficha de un paciente de toda
 * la vida arrancaría vacía y solo diría lo de hoy en adelante.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 *  1. Ventas con paciente (también las anuladas, que lo dicen) → registro 'venta'.
 *  2. Citas asistidas/completadas, o con valor/canje/adelanto → registro 'visita'.
 *  3. Las «Compra registrada desde la agenda» que caja ya escribía se marcan 'compra'.
 * Cada registro va FECHADO cuando pasó, no hoy. Es idempotente (un registro por
 * cita y por venta, índice único): repetirlo reescribe, no duplica.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/backfillObservacionesAutomaticasOnce.js             (DRY-RUN: cuenta)
 *   node scripts/backfillObservacionesAutomaticasOnce.js --commit    (aplica una vez)
 *   node scripts/backfillObservacionesAutomaticasOnce.js --commit --force
 */
const os = require('os');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const Sale = require('../models/Sale');
const Appointment = require('../models/Appointment');
const PatientObservation = require('../models/PatientObservation');
// Registrados para los populate de los textos.
require('../models/User');
require('../models/Clinic');
require('../models/Product');
require('../models/BankAccount');
require('../models/CreditCard');
require('../models/AppointmentServiceItem');
const { registrarVisita, registrarVenta } = require('../utils/observacionesAutomaticas');

const TASK_KEY = 'observaciones-automaticas-2026-09-29';
const STALE_RUNNING_MS = 60 * 60 * 1000;
const LOTE = 10;

const FILTRO_VISITAS = {
  patient: { $ne: null },
  $or: [
    { status: { $in: ['asistida', 'completada'] } },
    { isCanje: true },
    { agreedValue: { $ne: null } },
    { advancePayment: { $nin: ['', null] } },
  ],
};

/** De LOTE en LOTE: uno a uno serían horas contra Atlas, todos a la vez lo tumban. */
async function enLotes(ids, fn, log, etiqueta) {
  let hechos = 0;
  for (let i = 0; i < ids.length; i += LOTE) {
    // eslint-disable-next-line no-await-in-loop
    await Promise.all(ids.slice(i, i + LOTE).map(fn));
    hechos += Math.min(LOTE, ids.length - i);
    if (hechos % 500 < LOTE) log(`   … ${etiqueta}: ${hechos}/${ids.length}`);
  }
}

async function rellenar({ commit = false, log = console.log } = {}) {
  const ventas = await Sale.find({ patient: { $ne: null } }).select('_id createdBy').lean();
  const citas = await Appointment.find(FILTRO_VISITAS).select('_id createdBy valueSetBy').lean();
  const compras = await PatientObservation.countDocuments({
    'auto.kind': null, text: /^Compra registrada desde la agenda/,
  });
  log(`   • Ventas con paciente: ${ventas.length}`);
  log(`   • Citas atendidas o con cobro anotado: ${citas.length}`);
  log(`   • Compras de receta ya escritas por caja: ${compras}`);
  const stats = { ventas: ventas.length, visitas: citas.length, compras };
  if (!commit) {
    log('\nDRY-RUN: ejecuta con --commit para escribirlas.');
    return { ...stats, dryRun: true };
  }

  const opts = { fechaOriginal: true, lanzar: true };
  await enLotes(ventas, (v) => registrarVenta(v._id, v.createdBy, opts), log, 'ventas');
  await enLotes(citas, (c) => registrarVisita(c._id, c.valueSetBy || c.createdBy, opts), log, 'citas');
  await PatientObservation.updateMany(
    { 'auto.kind': null, text: /^Compra registrada desde la agenda/ },
    { $set: { auto: { kind: 'compra', ref: null } } },
    { timestamps: false }
  );
  log(`\n✅  ${ventas.length} venta(s) y ${citas.length} cita(s) registradas en Observaciones.`);
  return stats;
}

/** Envoltorio "una sola vez": reclama la marca de forma atómica y deja constancia. */
async function runOnce({ key = TASK_KEY, force = false, log = console.log } = {}) {
  const previa = await OneTimeTask.findById(key).lean();
  if (previa && !force) {
    if (previa.status === 'DONE') {
      log(`⏭️  Tarea "${key}" ya ejecutada el ${previa.finishedAt?.toISOString?.() || '—'}: no se hace nada.`);
      return { skipped: true, status: 'DONE' };
    }
    if (previa.status === 'RUNNING' && Date.now() - new Date(previa.startedAt).getTime() < STALE_RUNNING_MS) {
      log(`⏭️  Tarea "${key}" en ejecución por ${previa.host} (pid ${previa.pid}): no se hace nada.`);
      return { skipped: true, status: 'RUNNING' };
    }
    log(`↻  Intento anterior de "${key}" quedó en ${previa.status}: se reintenta.`);
  }

  const marca = {
    status: 'RUNNING', host: os.hostname(), pid: process.pid, startedAt: new Date(),
    finishedAt: null, error: '', result: null,
  };
  if (previa) {
    await OneTimeTask.updateOne({ _id: key }, { $set: marca, $inc: { attempts: 1 } });
  } else {
    try {
      await OneTimeTask.create({ _id: key, ...marca, attempts: 1 });
    } catch (e) {
      if (e.code === 11000) {
        log(`⏭️  Otro proceso reclamó "${key}" primero: no se hace nada.`);
        return { skipped: true, status: 'RUNNING' };
      }
      throw e;
    }
  }

  try {
    // El índice único de `auto` tiene que existir ANTES de escribir: es lo que
    // impide duplicar si el backend nuevo registra la misma venta a la vez.
    await PatientObservation.createIndexes();
    const result = await rellenar({ commit: true, log });
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'DONE', finishedAt: new Date(), result } });
    log(`🔒  Marca "${key}" = DONE: no volverá a ejecutarse en los próximos despliegues.`);
    return { skipped: false, status: 'DONE', result };
  } catch (e) {
    await OneTimeTask.updateOne({ _id: key }, { $set: { status: 'FAILED', finishedAt: new Date(), error: e.message } });
    throw e;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const force = args.includes('--force');

  console.log('\n=== Observaciones automáticas: relleno histórico (una sola vez) ===');
  console.log(`Clave de la tarea: ${TASK_KEY}`);
  console.log(commit ? 'MODO: COMMIT.' : 'MODO: DRY-RUN (solo cuenta). Usa --commit para aplicar.');
  console.log('');

  await connect();
  try {
    if (commit) await runOnce({ force });
    else await rellenar({ commit: false });
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('❌ ', e.message);
    process.exit(1);
  });
}

module.exports = { rellenar, runOnce, TASK_KEY };
