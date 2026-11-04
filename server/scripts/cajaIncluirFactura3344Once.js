#!/usr/bin/env node
/**
 * METER LA FACTURA 002-001-000003344 EN LA CAJA ABIERTA DE SU CAJERA — UNA SOLA VEZ.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * La factura se emitió ANTES de que la usuaria abriera su caja (antes de existir el bloqueo
 * «sin caja abierta no se factura», 04-11-2026). La caja cuenta las ventas desde su apertura,
 * así que esa venta no aparecía en «Facturas de esta caja» ni en su cuadre.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 * Adelanta la APERTURA de la caja abierta del dueño del punto 002-001 a un segundo antes de
 * la venta. No toca la fecha de la venta ni de la factura (son documentos ya emitidos al SRI):
 * es la caja la que se abrió tarde. Con eso la venta entra en la lista, en el total y en el
 * efectivo esperado (su asiento queda dentro de la ventana). Si la venta no estaba enlazada al
 * punto, se enlaza (lo que habría pasado con la caja abierta). Deja constancia en las notas.
 *
 * Se niega si: la caja ya incluye la venta, la venta es de otro punto, o adelantar la apertura
 * la solaparía con una caja anterior del mismo punto (la venta contaría en dos cierres).
 * Lista además las demás ventas del punto que caen en ese intervalo y entrarán también.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/cajaIncluirFactura3344Once.js             (DRY-RUN: solo muestra)
 *   node scripts/cajaIncluirFactura3344Once.js --commit    (aplica una vez y deja marca)
 *   node scripts/cajaIncluirFactura3344Once.js --estado    (solo muestra la marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const Invoice = require('../models/Invoice');
const Sale = require('../models/Sale');
const CashClosing = require('../models/CashClosing');
const PuntoEmision = require('../models/PuntoEmision');
const User = require('../models/User');

const TASK_KEY = 'caja-incluir-factura-002-001-000003344';
const STALE_RUNNING_MS = 30 * 60 * 1000;
const FACTURA = { estab: '002', ptoEmi: '001', secuencial: '000003344' };
const str = (v) => (v ? String(v._id || v) : '');

async function plan(log) {
  const inv = await Invoice.findOne(FACTURA).lean();
  if (!inv) throw new Error('No se encontró la factura 002-001-000003344');
  const venta = inv.sale ? await Sale.findById(inv.sale).lean() : await Sale.findOne({ invoice: inv._id }).lean();
  if (!venta) throw new Error('La factura no tiene venta enlazada');
  const punto = await PuntoEmision.findOne({ establecimiento: '002', codigo: '001', activo: true }).lean();
  if (!punto?.usuario) throw new Error('No se encontró el punto 002-001 activo con usuario');
  const duenia = await User.findById(punto.usuario).select('name').lean();
  const registro = venta.createdBy ? await User.findById(venta.createdBy).select('name').lean() : null;

  log(`   • Factura 002-001-000003344 (${inv.estado}) → venta ${venta.saleNumber} del ${venta.createdAt.toISOString()} por $${Number(venta.total).toFixed(2)}`);
  log(`   • Registró la venta: ${registro?.name || '—'} · dueña del punto 002-001: ${duenia?.name || '—'}`);
  if (venta.status !== 'completada') throw new Error(`La venta está ${venta.status}: no se mete en la caja`);
  if (venta.puntoEmision && str(venta.puntoEmision) !== str(punto._id)) {
    throw new Error('La venta está enlazada a OTRO punto de emisión: revisar a mano');
  }

  const caja = await CashClosing.findOne({ status: 'ABIERTA', openedBy: punto.usuario, clinic: venta.clinic }).sort({ openedAt: -1 }).lean();
  if (!caja) throw new Error(`${duenia?.name || 'La usuaria'} no tiene una caja ABIERTA en la sucursal de la venta`);
  if (caja.puntoEmision && str(caja.puntoEmision) !== str(punto._id)) throw new Error('La caja abierta es de otro punto: revisar a mano');
  log(`   • Caja abierta ${caja._id} desde ${caja.openedAt.toISOString()} (fondo $${Number(caja.openingBalance || 0).toFixed(2)})`);

  if (caja.openedAt <= venta.createdAt) {
    log('   • La caja ya incluye la venta por fecha.');
    return { inv, venta, punto, caja, nuevaApertura: null };
  }
  const nuevaApertura = new Date(venta.createdAt.getTime() - 1000);

  // Una caja anterior del mismo punto que siga «viva» en ese intervalo contaría la venta dos veces.
  const solapada = await CashClosing.findOne({
    _id: { $ne: caja._id },
    status: { $ne: 'ANULADO' },
    clinic: venta.clinic,
    $or: [{ puntoEmision: punto._id }, { openedBy: punto.usuario }],
    openedAt: { $lt: caja.openedAt },
    closedAt: { $gt: nuevaApertura },
  }).lean();
  if (solapada) throw new Error(`La caja ${solapada._id} (cerrada ${solapada.closedAt?.toISOString()}) ya cubre ese intervalo: la venta contaría dos veces`);

  const otras = await Sale.find({
    _id: { $ne: venta._id },
    clinic: venta.clinic,
    puntoEmision: punto._id,
    createdAt: { $gte: nuevaApertura, $lt: caja.openedAt },
  }).select('saleNumber createdAt total status').lean();
  log(`   • Nueva apertura: ${nuevaApertura.toISOString()} (antes ${caja.openedAt.toISOString()})`);
  log(`   • Otras ventas del punto en ese intervalo que también entrarán: ${otras.length}`);
  for (const o of otras) log(`     - ${o.saleNumber} ${o.createdAt.toISOString()} $${Number(o.total).toFixed(2)} ${o.status}`);
  return { inv, venta, punto, caja, nuevaApertura, otras };
}

async function aplicar({ commit = false, log = console.log } = {}) {
  const p = await plan(log);
  if (!commit) return { dryRun: true };
  if (!p.venta.puntoEmision) {
    await Sale.updateOne({ _id: p.venta._id, puntoEmision: null }, { $set: { puntoEmision: p.punto._id } });
    log(`   ✓ Venta ${p.venta.saleNumber} enlazada al punto 002-001`);
  }
  if (p.nuevaApertura) {
    const nota = `[${new Date().toISOString()}] Apertura adelantada de ${p.caja.openedAt.toISOString()} a ${p.nuevaApertura.toISOString()} para incluir la factura 002-001-000003344 (${p.venta.saleNumber}), emitida antes de abrir la caja.`;
    const r = await CashClosing.updateOne(
      { _id: p.caja._id, status: 'ABIERTA', openedAt: p.caja.openedAt },
      { $set: { openedAt: p.nuevaApertura, date: p.nuevaApertura, notes: [p.caja.notes, nota].filter(Boolean).join('\n') } },
    );
    if (!r.modifiedCount) throw new Error('La caja cambió mientras tanto (¿se cerró?): no se tocó nada');
    log(`   ✓ Caja ${p.caja._id}: apertura adelantada a ${p.nuevaApertura.toISOString()}`);
  }
  return {
    caja: str(p.caja._id),
    venta: p.venta.saleNumber,
    aperturaAnterior: p.caja.openedAt,
    aperturaNueva: p.nuevaApertura,
    otrasVentasIncluidas: (p.otras || []).map((o) => o.saleNumber),
  };
}

/** Envoltorio "una sola vez": reclama la marca de forma atómica y deja constancia. */
async function runOnce({ key = TASK_KEY, log = console.log } = {}) {
  const previa = await OneTimeTask.findById(key).lean();
  if (previa) {
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
  const marca = { status: 'RUNNING', host: os.hostname(), pid: process.pid, startedAt: new Date(), finishedAt: null, error: '', result: null };
  if (previa) {
    await OneTimeTask.updateOne({ _id: key }, { $set: marca, $inc: { attempts: 1 } });
  } else {
    try {
      await OneTimeTask.create({ _id: key, ...marca, attempts: 1 });
    } catch (e) {
      if (e.code === 11000) { log(`⏭️  Otro proceso reclamó "${key}" primero: no se hace nada.`); return { skipped: true, status: 'RUNNING' }; }
      throw e;
    }
  }
  try {
    const result = await aplicar({ commit: true, log });
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
  console.log('\n=== INCLUIR LA FACTURA 002-001-000003344 EN SU CAJA ABIERTA (una sola vez) ===');
  console.log(commit ? 'MODO: COMMIT.' : 'MODO: DRY-RUN (solo muestra). Usa --commit para aplicar.');
  await connect();
  try {
    if (args.includes('--estado')) {
      const previa = await OneTimeTask.findById(TASK_KEY).lean();
      console.log(previa ? `Estado: ${previa.status} · ${JSON.stringify(previa.result || previa.error)}` : 'Estado: sin marca.');
      return;
    }
    if (!commit) { await aplicar({ commit: false }); return; }
    await runOnce();
  } finally {
    await disconnect();
  }
}

module.exports = { aplicar, runOnce, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
