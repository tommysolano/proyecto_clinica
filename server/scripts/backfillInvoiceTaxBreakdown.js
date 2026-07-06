/**
 * Backfill del snapshot tributario por tarifa (`taxBreakdown`) en facturas de VENTA
 * antiguas que se emitieron antes de que la factura lo guardara.
 *
 * Para cada factura SIN `taxBreakdown`:
 *   - si tiene venta origen (`sale`) con ítems → recalcula el desglose EXACTO por
 *     tarifa desde la venta (breakdownFromSale) y lo guarda con `computed:true`;
 *   - si no hay venta o no tiene ítems → NO escribe: los reportes ya derivan un
 *     fallback seguro por totales (IVA>0 ⇒ gravada; IVA=0 ⇒ 0%). Persistir el
 *     fallback no aporta y ocultaría que fue estimado, así que se deja tal cual.
 *
 * Esto es importante sobre todo para facturas MIXTAS antiguas (0% + 15% en el mismo
 * comprobante): el fallback por totales no las separa bien, pero la venta origen sí.
 *
 * Dry-run por defecto; usa --commit para aplicar. --clinic=<id> opcional.
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Invoice = require('../models/Invoice');
const Sale = require('../models/Sale');
const { breakdownFromSale } = require('../utils/invoiceTaxBreakdown');

async function run() {
  const opts = parseArgs();
  banner('Backfill taxBreakdown en facturas de venta', opts);
  await connect();
  try {
    const filter = { taxBreakdown: { $exists: false } };
    if (opts.clinic) filter.clinic = opts.clinic;
    const invoices = await Invoice.find(filter).select('_id sale totalSinImpuestos totalImpuesto').lean();
    console.log(`Facturas sin taxBreakdown: ${invoices.length}`);

    let withSale = 0;
    let fallbackOnly = 0;
    const updates = [];
    for (const inv of invoices) {
      if (!inv.sale) { fallbackOnly += 1; continue; }
      const sale = await Sale.findById(inv.sale).select('items subtotal0 subtotalExento subtotalNoObjeto taxableSubtotal taxAmount').lean();
      if (!sale || !Array.isArray(sale.items) || sale.items.length === 0) { fallbackOnly += 1; continue; }
      const tb = breakdownFromSale(sale);
      withSale += 1;
      updates.push({
        _id: inv._id,
        taxBreakdown: {
          base0: tb.base0, baseGravada: tb.baseGravada, baseExento: tb.baseExento,
          baseNoObjeto: tb.baseNoObjeto, iva: tb.iva, rates: tb.rates, computed: true,
        },
      });
    }

    console.log(`A recalcular desde la venta origen: ${withSale}`);
    console.log(`Sin venta con ítems (se quedan en fallback por totales): ${fallbackOnly}`);
    for (const u of updates.slice(0, 15)) {
      console.log(`  - ${u._id}: 0%=${u.taxBreakdown.base0}  15%=${u.taxBreakdown.baseGravada}  IVA=${u.taxBreakdown.iva}`);
    }
    if (updates.length > 15) console.log(`  … y ${updates.length - 15} más`);

    if (opts.dryRun) {
      console.log('\nDRY-RUN: no se escribió nada. Ejecuta con --commit para aplicar.');
      return;
    }
    for (const u of updates) {
      await Invoice.updateOne({ _id: u._id }, { $set: { taxBreakdown: u.taxBreakdown } });
    }
    console.log(`\nListo. Snapshots escritos: ${updates.length}.`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
