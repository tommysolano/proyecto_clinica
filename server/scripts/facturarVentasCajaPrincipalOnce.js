#!/usr/bin/env node
/**
 * FACTURAR LAS VENTAS QUE SE QUEDARON SIN FACTURA EN «CAJA PRINCIPAL» — UNA SOLA VEZ.
 *
 * ─── POR QUÉ ───────────────────────────────────────────────────────────────────────
 * El 29-10-2026 el laboratorio empezó a cobrar en Vikingo. Su cajera solo trabaja en la
 * sucursal Laboratorio, pero su caja «Caja principal» (003-001) y la configuración SRI
 * estaban en Central, y el sistema las buscaba en la sucursal activa: sus cobros se
 * guardaron sin factura y sin aviso. El código ya trata la configuración y los puntos
 * como de la EMPRESA (services/puntoEmision → sucursalSri); esta tarea factura lo que
 * quedó pendiente.
 *
 * ─── QUÉ HACE ──────────────────────────────────────────────────────────────────────
 * Toma las ventas COMPLETADAS y SIN factura, registradas desde el 29-10-2026 por la dueña
 * del punto 003-001, y emite cada una con el MISMO controlador del botón «Facturar»,
 * como ella (serie 003-001, su ambiente, su numeración). Deja la venta enlazada a su punto
 * (lo que habría pasado al cobrar). Una venta que ya tenga factura se salta.
 *
 * ─── USO ───────────────────────────────────────────────────────────────────────────
 *   node scripts/facturarVentasCajaPrincipalOnce.js             (DRY-RUN: solo lista)
 *   node scripts/facturarVentasCajaPrincipalOnce.js --commit    (emite una vez y deja marca)
 *   node scripts/facturarVentasCajaPrincipalOnce.js --estado    (solo muestra la marca)
 */
const os = require('os');
const { connect, disconnect } = require('./_common');

const OneTimeTask = require('../models/OneTimeTask');
const PuntoEmision = require('../models/PuntoEmision');
const Sale = require('../models/Sale');
const User = require('../models/User');

const TASK_KEY = 'facturar-ventas-caja-principal-2026-10-29';
const STALE_RUNNING_MS = 30 * 60 * 1000;
const DESDE = new Date('2026-10-29T00:00:00-05:00');

async function pendientes() {
  const punto = await PuntoEmision.findOne({ establecimiento: '003', codigo: '001', nombre: /caja principal/i, activo: true }).lean();
  if (!punto?.usuario) throw new Error('No se encontró el punto 003-001 «Caja principal» con usuario');
  const user = await User.findById(punto.usuario).lean();
  const ventas = await Sale.find({
    $or: [{ createdBy: punto.usuario }, { cashier: punto.usuario }],
    status: 'completada',
    invoice: null,
    createdAt: { $gte: DESDE },
  }).sort({ createdAt: 1 });
  return { punto, user, ventas };
}

/** Llama al controlador como lo haría el botón «Facturar» de la cajera. */
async function emitir(venta, user, User) {
  const { emitFromSale } = require('../controllers/invoiceController');
  const doc = await User.findById(user._id);
  const req = {
    clinicId: String(venta.clinic),
    user: doc,
    role: doc.getRoleForClinic(venta.clinic) || 'cajero',
    params: { saleId: String(venta._id) },
    body: {},
    query: {},
  };
  return new Promise((resolve) => {
    const res = {
      statusCode: 200,
      status(code) { this.statusCode = code; return this; },
      json(payload) { resolve({ status: this.statusCode, payload }); return this; },
    };
    emitFromSale(req, res).catch((e) => resolve({ status: 500, payload: { message: e.message } }));
  });
}

async function facturar({ commit = false, log = console.log } = {}) {
  const { punto, user, ventas } = await pendientes();
  log(`   • Punto ${punto.establecimiento}-${punto.codigo} (${punto.nombre}) de ${user?.name}; próximo secuencial ${punto.secuencialFactura}`);
  log(`   • Ventas sin factura desde el 29-10-2026: ${ventas.length}`);
  for (const v of ventas) log(`     - ${v.saleNumber} ${v.createdAt.toISOString()} $${Number(v.total).toFixed(2)} ${v.clientName || ''}`);
  if (!commit) return { pendientes: ventas.length };

  const resultado = [];
  for (const v of ventas) {
    // Lo que habría quedado al cobrar con su caja (la caja y los cierres cuentan por punto).
    if (!v.puntoEmision) await Sale.updateOne({ _id: v._id }, { $set: { puntoEmision: punto._id } });
    // eslint-disable-next-line no-await-in-loop
    const r = await emitir(v, user, User);
    const inv = r.payload?.invoice || r.payload;
    const linea = {
      venta: v.saleNumber, http: r.status, estado: inv?.estado || null,
      numero: inv?.secuencial ? `${inv.estab}-${inv.ptoEmi}-${inv.secuencial}` : null,
      mensaje: r.status >= 400 ? (r.payload?.message || '') : '',
    };
    resultado.push(linea);
    log(`     → ${linea.venta}: ${linea.http} ${linea.estado || ''} ${linea.numero || ''} ${linea.mensaje}`);
  }
  const fallidas = resultado.filter((x) => x.http >= 400 && x.http !== 202);
  if (fallidas.length) throw new Error(`${fallidas.length} venta(s) no se pudieron facturar: ${JSON.stringify(fallidas)}`);
  return { facturadas: resultado };
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
    const result = await facturar({ commit: true, log });
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
  console.log('\n=== FACTURAR VENTAS SIN FACTURA DE «CAJA PRINCIPAL» (una sola vez) ===');
  console.log(commit ? 'MODO: COMMIT (emite al SRI).' : 'MODO: DRY-RUN (solo lista). Usa --commit para emitir.');
  await connect();
  try {
    if (args.includes('--estado')) {
      const previa = await OneTimeTask.findById(TASK_KEY).lean();
      console.log(previa ? `Estado: ${previa.status} · ${JSON.stringify(previa.result || previa.error)}` : 'Estado: sin marca.');
      return;
    }
    if (!commit) { await facturar({ commit: false }); return; }
    await runOnce();
  } finally {
    await disconnect();
  }
}

module.exports = { facturar, runOnce, TASK_KEY };

if (require.main === module) {
  main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
}
