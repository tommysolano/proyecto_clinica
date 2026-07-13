/**
 * Backfill del VENCIMIENTO en las cuentas por pagar originadas en compras.
 *
 * Hasta ahora la CxP se abría sin `dueDate` aunque la compra tuviera
 * `fechaVencimiento`, así que la cartera y la proyección de flujo de caja no
 * podían distinguir vencido de por vencer. Este script completa la fecha SOLO
 * cuando falta.
 *
 * Garantías:
 *  - Idempotente: correrlo dos veces no cambia nada la segunda vez.
 *  - NO sobrescribe fechas ya presentes (pudieron corregirse a mano en cartera).
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

async function run() {
  const { commit, clinic, dryRun } = parseArgs();
  banner('Backfill de vencimientos en CxP (compras)', { dryRun, clinic });

  await connect();

  const filter = { sourceModel: 'PurchaseInvoice' };
  if (clinic) filter.clinic = clinic;

  const payables = await Payable.find(filter).select('clinic sourceRef dueDate number status');
  const stats = { encontrados: payables.length, modificados: 0, omitidos: 0, huerfanos: 0, sinVencimientoEnCompra: 0 };
  const ejemplos = [];
  const huerfanos = [];

  for (const p of payables) {
    // Ya tiene fecha (propagada al crear o corregida a mano): no se toca.
    if (p.dueDate) { stats.omitidos += 1; continue; }

    const inv = await PurchaseInvoice.findOne({ _id: p.sourceRef, clinic: p.clinic })
      .select('fechaVencimiento serie');
    if (!inv) {
      stats.huerfanos += 1;
      if (huerfanos.length < 20) huerfanos.push({ payable: String(p._id), sourceRef: String(p.sourceRef), number: p.number });
      continue;
    }
    // La compra es al contado / sin vencimiento pactado: no hay fecha que copiar.
    if (!inv.fechaVencimiento) { stats.sinVencimientoEnCompra += 1; continue; }

    stats.modificados += 1;
    if (ejemplos.length < 10) {
      ejemplos.push({ cxp: p.number || String(p._id), dueDate: inv.fechaVencimiento.toISOString().slice(0, 10) });
    }
    if (commit) {
      await Payable.updateOne({ _id: p._id }, { $set: { dueDate: inv.fechaVencimiento } });
    }
  }

  console.log('Resultado:');
  console.log(`  Encontrados (CxP de compras) ....... ${stats.encontrados}`);
  console.log(`  Modificados (fecha completada) ..... ${stats.modificados}${dryRun ? ' (simulado)' : ''}`);
  console.log(`  Omitidos (ya tenían fecha) ......... ${stats.omitidos}`);
  console.log(`  Compra sin vencimiento (contado) ... ${stats.sinVencimientoEnCompra}`);
  console.log(`  Huérfanos (compra inexistente) ..... ${stats.huerfanos}`);
  if (ejemplos.length) {
    console.log('\n  Ejemplos a completar:');
    for (const e of ejemplos) console.log(`    ${e.cxp} → ${e.dueDate}`);
  }
  if (huerfanos.length) {
    console.log('\n  Huérfanos (revisar manualmente):');
    for (const h of huerfanos) console.log(`    CxP ${h.number || h.payable} → compra ${h.sourceRef} no existe`);
  }
  if (dryRun && stats.modificados > 0) console.log('\nDRY-RUN: vuelve a correr con --commit para aplicar.');

  await disconnect();
  return stats;
}

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run };
