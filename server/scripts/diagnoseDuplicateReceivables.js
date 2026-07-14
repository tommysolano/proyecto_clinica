/**
 * DIAGNÓSTICO (solo lectura) de cuentas por cobrar DUPLICADAS entre una venta y su factura.
 *
 * `scripts/migrateCarteraToSubledger.js` abría cartera para toda venta a crédito con saldo Y
 * para toda factura con saldo, sin mirar el vínculo `Sale.invoice`. Una venta a crédito que
 * además se facturó pudo quedar con DOS CxC para UNA sola obligación económica.
 *
 * Este script NO corrige nada: no borra, no fusiona y no toca aplicaciones históricas. Solo
 * REPORTA los pares y su clasificación, con la MISMA lógica que usan el flujo de caja y la
 * antigüedad de cartera (`services/receivableObligations.js`), para que lo que veas aquí sea
 * exactamente lo que están usando los reportes:
 *
 *   SAFE_DUPLICATE           → consolidable automáticamente (sin actividad, o los mismos cobros).
 *   DIVERGENT_BUT_RESOLVABLE → la actividad real está en una sola: manda esa (no siempre la venta).
 *   AMBIGUOUS                → no concilia: hay que resolverlo a mano. NO se consolida solo.
 *
 * Uso:
 *   node scripts/diagnoseDuplicateReceivables.js                 (todas las clínicas)
 *   node scripts/diagnoseDuplicateReceivables.js --clinic=<id>   (una clínica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Clinic = require('../models/Clinic');
const Invoice = require('../models/Invoice');
const { resolveReceivableEconomicObligations, RESOLUTION } = require('../services/receivableObligations');

const money = (n) => Number(n || 0).toFixed(2);

/** Diagnóstico puro (sin conectar/desconectar): las pruebas ejercitan ESTE código. */
async function diagnose({ clinic = null } = {}) {
  const clinicas = clinic
    ? [{ _id: clinic }]
    : await Clinic.find({}).select('_id name').lean();

  const stats = {
    pares: 0, duplicadas: 0, safe: 0, divergentes: 0, ambiguas: 0, corregiblesAuto: 0,
  };
  const detalle = [];

  for (const c of clinicas) {
    const res = await resolveReceivableEconomicObligations({ clinicId: c._id });
    for (const o of res.obligations) {
      stats.pares += 1;
      const dosCarteras = !!(o.receivables.venta && o.receivables.factura);
      if (dosCarteras) stats.duplicadas += 1;
      if (o.resolution === RESOLUTION.SAFE) stats.safe += 1;
      if (o.resolution === RESOLUTION.DIVERGENT) stats.divergentes += 1;
      if (o.resolution === RESOLUTION.AMBIGUOUS) stats.ambiguas += 1;
      if (dosCarteras && o.autoFixable) stats.corregiblesAuto += 1;

      const iv = await Invoice.findById(o.factura.id).select('estab ptoEmi secuencial estado').lean();
      detalle.push({
        clinic: String(c._id),
        obligacion: o,
        dosCarteras,
        numeroFactura: iv ? `${iv.estab}-${iv.ptoEmi}-${iv.secuencial}` : '(sin factura)',
      });
    }
  }

  console.log('Resultado:');
  console.log(`  Pares venta↔factura ................... ${stats.pares}`);
  console.log(`  · con DOS carteras (duplicadas) ....... ${stats.duplicadas}`);
  console.log(`  · SAFE_DUPLICATE ...................... ${stats.safe}`);
  console.log(`  · DIVERGENT_BUT_RESOLVABLE ............ ${stats.divergentes}`);
  console.log(`  · AMBIGUOUS (requieren decisión) ...... ${stats.ambiguas}`);
  console.log(`  · corregibles automáticamente ......... ${stats.corregiblesAuto}`);

  for (const d of detalle) {
    const o = d.obligacion;
    const rv = o.receivables.venta;
    const rf = o.receivables.factura;
    console.log(`\n  ── Venta ${o.venta.numero || o.venta.id} · factura ${d.numeroFactura} · [${o.resolution}]`);
    console.log(`     Motivo: ${o.reason}`);
    console.log(`     CxC venta   ${rv ? `${rv.id}  total ${money(rv.total)}  aplicado ${money(rv.applied)}  saldo ${money(rv.balance)}  ${rv.status}` : '(no existe)'}`);
    console.log(`     CxC factura ${rf ? `${rf.id}  total ${money(rf.total)}  aplicado ${money(rf.applied)}  saldo ${money(rf.balance)}  ${rf.status}` : '(no existe)'}`);
    if (o.cobros.length) {
      console.log('     Cobros:');
      for (const p of o.cobros) {
        console.log(`       · ${p.numero || p.paymentId} ${p.status}  venta ${money(p.onSale)}  factura ${money(p.onInvoice)}`
          + `  → único ${money(p.amount)}${p.enAmbas ? '  (reflejado en AMBAS: cuenta una vez)' : ''}`);
      }
    }
    if (o.anulaciones.length) {
      console.log(`     Anulaciones: ${o.anulaciones.map((a) => `${a.numero || a.paymentId} (${money(a.amount)})`).join(', ')}`);
    }
    console.log(`     Cobros únicos ${money(o.cobrosUnicos)}  ·  Documento canónico: ${o.canonical.sourceModel}`);
    console.log(`     SALDO ECONÓMICO SUGERIDO: ${money(o.total)} − ${money(o.applied)} = ${money(o.balance)}`);
    console.log(`     Corrección automática: ${d.dosCarteras ? (o.autoFixable ? 'SÍ (consolidable)' : 'NO — decisión manual') : 'no aplica (una sola cartera)'}`);
  }

  if (stats.ambiguas) {
    console.log('\n  Los casos AMBIGUOUS NO se consolidan solos: el flujo y la antigüedad muestran el');
    console.log('  saldo más conservador, avisan y enseñan las dos referencias. Hay que decidirlos a mano.');
  }
  if (!stats.pares) console.log('\n  No se encontraron ventas facturadas con cartera.');

  return { ...stats, detalle };
}

async function run() {
  const { clinic } = parseArgs();
  banner('Diagnóstico: CxC duplicadas entre venta y factura', { dryRun: true, clinic });
  await connect();
  try {
    return await diagnose({ clinic });
  } finally {
    await disconnect();
  }
}

if (require.main === module) {
  run().catch((e) => { console.error(e); process.exit(1); });
}

module.exports = { run, diagnose };
