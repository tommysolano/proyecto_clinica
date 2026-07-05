/**
 * Backfill OPCIONAL de `strictAccounts` en compras del flujo nuevo.
 *
 * Contexto: entre los commits 26aca34 y 4d0c5dc las compras nacían estrictas pero el
 * campo `strictAccounts` no existía todavía, así que quedaron en `false`/ausente y al
 * editarse se tratan como legacy (tolerantes). Este script marca `strictAccounts=true`
 * las compras que CLARAMENTE usan el flujo nuevo: REGISTRADA/PAGADA y con al menos una
 * línea que trae `inventoryCategory` o un tipo de línea explícito INVENTARIO/ACTIVO_FIJO.
 *
 * No toca compras legacy reales (sin esas señales) para no romper su edición tolerante.
 * Dry-run por defecto; usa --commit para aplicar. --clinic=<id> opcional.
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const PurchaseInvoice = require('../models/PurchaseInvoice');

function looksNewFlow(inv) {
  if (inv.strictAccounts === true) return false; // ya marcada
  if (!['REGISTRADA', 'PAGADA'].includes(inv.status)) return false;
  return (inv.items || []).some((it) => it.inventoryCategory || it.lineType === 'INVENTARIO' || it.lineType === 'ACTIVO_FIJO');
}

async function run() {
  const opts = parseArgs();
  banner('Backfill strictAccounts en compras nuevas', opts);
  await connect();
  try {
    const filter = { strictAccounts: { $ne: true }, status: { $in: ['REGISTRADA', 'PAGADA'] } };
    if (opts.clinic) filter.clinic = opts.clinic;
    const invs = await PurchaseInvoice.find(filter).select('status items strictAccounts serie');
    const target = invs.filter(looksNewFlow);
    console.log(`Compras candidatas (no marcadas): ${invs.length}`);
    console.log(`A marcar como strictAccounts=true: ${target.length}`);
    for (const inv of target.slice(0, 20)) console.log(`  - ${inv.serie || inv._id} (${inv.status})`);
    if (target.length > 20) console.log(`  … y ${target.length - 20} más`);

    if (opts.dryRun) {
      console.log('\nDRY-RUN: no se escribió nada. Ejecuta con --commit para aplicar.');
      return;
    }
    const ids = target.map((i) => i._id);
    const res = await PurchaseInvoice.updateMany({ _id: { $in: ids } }, { $set: { strictAccounts: true } });
    console.log(`\nActualizadas: ${res.modifiedCount}`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
