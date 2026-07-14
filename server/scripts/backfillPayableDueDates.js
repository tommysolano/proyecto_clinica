/**
 * Backfill del VENCIMIENTO en las cuentas por pagar originadas en compras.
 *
 * La CxP se abría sin `dueDate` aunque la compra tuviera `fechaVencimiento` o un plazo de
 * crédito pactado, así que la cartera y la proyección de flujo de caja no podían distinguir
 * vencido de por vencer. Este script completa la fecha SOLO cuando falta, con la MISMA
 * prioridad que usa el sistema al abrir la CxP (utils/purchaseDueDate: fuente única):
 *
 *   1. `PurchaseInvoice.fechaVencimiento` explícita
 *   2. días de crédito guardados en la compra
 *   3. días de crédito ACTUALES del proveedor
 *   4. sin plazo → no se inventa fecha
 *
 * Garantías:
 *  - Idempotente: correrlo dos veces no cambia nada la segunda vez.
 *  - NUNCA sobrescribe una fecha existente (pudo corregirse a mano en cartera).
 *  - NUNCA toca CxP pagadas o anuladas: solo se reportan en el diagnóstico.
 *  - Aislado por clínica con --clinic=<id>.
 *  - DRY-RUN por defecto: no escribe salvo --commit.
 *
 * Uso:
 *   node scripts/backfillPayableDueDates.js                    (dry-run, todas)
 *   node scripts/backfillPayableDueDates.js --clinic=<id>      (dry-run, una clínica)
 *   node scripts/backfillPayableDueDates.js --commit           (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Payable = require('../models/Payable');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Supplier = require('../models/Supplier');
const { resolvePurchaseDueDate } = require('../utils/purchaseDueDate');

const iso = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * Lógica del backfill, SIN conectar ni desconectar: opera sobre la conexión de mongoose ya
 * abierta. Así las pruebas ejercitan exactamente este código (y no una copia de él) contra la
 * base en memoria, en vez de reimplementarlo.
 */
async function backfillDueDates({ commit = false, clinic = null } = {}) {
  const dryRun = !commit;
  const filter = { sourceModel: 'PurchaseInvoice' };
  if (clinic) filter.clinic = clinic;

  const payables = await Payable.find(filter).select('clinic sourceRef dueDate number status');
  const stats = {
    encontradas: payables.length,
    elegibles: 0,
    desdeCompra: 0,       // fecha explícita o días de crédito de la propia compra
    desdeProveedor: 0,    // días de crédito del proveedor
    omitidas: 0,          // ya tenían fecha
    cerradas: 0,          // pagadas/anuladas: solo se reportan, no se tocan
    sinProveedor: 0,
    sinPlazo: 0,
    huerfanas: 0,
  };
  const ejemplos = [];
  const huerfanas = [];
  const cerradasSinFecha = [];

  for (const p of payables) {
    // Ya tiene fecha (propagada al crear, corregida a mano o por un backfill previo).
    if (p.dueDate) { stats.omitidas += 1; continue; }

    // Pagada o anulada: no se toca, solo se informa.
    if (p.status === 'PAGADO' || p.status === 'ANULADO') {
      stats.cerradas += 1;
      if (cerradasSinFecha.length < 20) cerradasSinFecha.push({ cxp: p.number || String(p._id), status: p.status });
      continue;
    }

    const inv = await PurchaseInvoice.findOne({ _id: p.sourceRef, clinic: p.clinic })
      .select('fechaEmision fechaVencimiento creditDays supplier serie');
    if (!inv) {
      stats.huerfanas += 1;
      if (huerfanas.length < 20) huerfanas.push({ payable: String(p._id), sourceRef: String(p.sourceRef), number: p.number });
      continue;
    }

    let sup = null;
    if (inv.supplier) {
      sup = await Supplier.findOne({ _id: inv.supplier, clinic: p.clinic }).select('creditDays razonSocial');
    }
    if (!sup && !inv.fechaVencimiento && !(Number(inv.creditDays) > 0)) stats.sinProveedor += 1;

    const { dueDate, source, creditDays } = resolvePurchaseDueDate(inv, sup);
    if (!dueDate) { stats.sinPlazo += 1; continue; }

    stats.elegibles += 1;
    if (source === 'PROVEEDOR') stats.desdeProveedor += 1;
    else stats.desdeCompra += 1;

    if (ejemplos.length < 10) {
      ejemplos.push({
        cxp: p.number || String(p._id),
        dueDate: iso(dueDate),
        source,
        creditDays,
      });
    }
    if (commit) {
      // Guarda condicional: solo si SIGUE sin fecha (por si otro proceso la puso entretanto).
      await Payable.updateOne({ _id: p._id, dueDate: null }, { $set: { dueDate } });
    }
  }

  console.log('Resultado:');
  console.log(`  Encontradas (CxP de compras) ............ ${stats.encontradas}`);
  console.log(`  Elegibles (abiertas y sin fecha) ........ ${stats.elegibles}${dryRun ? ' (simulado)' : ''}`);
  console.log(`    · calculadas desde la compra .......... ${stats.desdeCompra}`);
  console.log(`    · calculadas desde el proveedor ....... ${stats.desdeProveedor}`);
  console.log(`  Omitidas (ya tenían fecha) .............. ${stats.omitidas}`);
  console.log(`  Cerradas (pagadas/anuladas, no se tocan)  ${stats.cerradas}`);
  console.log(`  Sin proveedor ........................... ${stats.sinProveedor}`);
  console.log(`  Sin plazo (ni fecha ni días de crédito) . ${stats.sinPlazo}`);
  console.log(`  Huérfanas (la compra no existe) ......... ${stats.huerfanas}`);
  if (ejemplos.length) {
    console.log('\n  Ejemplos a completar:');
    for (const e of ejemplos) {
      console.log(`    ${e.cxp} → ${e.dueDate}  [${e.source}${e.creditDays ? ` ${e.creditDays}d` : ''}]`);
    }
  }
  if (cerradasSinFecha.length) {
    console.log('\n  CxP cerradas sin vencimiento (solo diagnóstico, NO se modifican):');
    for (const c of cerradasSinFecha) console.log(`    ${c.cxp} (${c.status})`);
  }
  if (huerfanas.length) {
    console.log('\n  Huérfanas (revisar manualmente):');
    for (const h of huerfanas) console.log(`    CxP ${h.number || h.payable} → compra ${h.sourceRef} no existe`);
  }
  if (dryRun && stats.elegibles > 0) console.log('\nDRY-RUN: vuelve a correr con --commit para aplicar.');

  return stats;
}

async function run() {
  const { commit, clinic, dryRun } = parseArgs();
  banner('Backfill de vencimientos en CxP (compras)', { dryRun, clinic });
  await connect();
  try {
    return await backfillDueDates({ commit, clinic });
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run, backfillDueDates };
