/**
 * SCRIPT DE UN SOLO USO — Borra TODAS las facturas de Compras y sus artefactos
 * contables/inventario asociados, para poder reimportar el TXT del SRI desde cero.
 *
 * Elimina, por factura de compra:
 *   - PurchaseInvoice
 *   - JournalEntry (asientos de compra / ediciones / retención)  [sourceModel=PurchaseInvoice]
 *   - Payable (CxP)                                              [sourceModel=PurchaseInvoice]
 *   - InventoryMovement (entradas por compra)                   [sourceModel=PurchaseInvoice]
 *   - InventoryLayer (capas kardex por compra)                  [sourceModel=PurchaseInvoice]
 * Luego recalcula el stock/costo de los productos afectados desde las capas vivas.
 *
 * Por seguridad es DRY-RUN por defecto (solo cuenta). Aplica con --commit.
 * Si hay Pagos (Payment) que aplican a compras, AVISA y NO borra nada salvo que
 * además pases --force (esos pagos quedarían inconsistentes).
 *
 *   node scripts/wipePurchaseInvoices.js                 (dry-run, muestra qué borraría)
 *   node scripts/wipePurchaseInvoices.js --commit        (borra; aborta si hay pagos)
 *   node scripts/wipePurchaseInvoices.js --commit --force(borra aunque haya pagos)
 *   node scripts/wipePurchaseInvoices.js --commit --clinic=<id>   (solo una clínica)
 */
const { parseArgs, connect, disconnect, banner, mongoose } = require('./_common');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const JournalEntry = require('../models/JournalEntry');
const Payable = require('../models/Payable');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryLayer = require('../models/InventoryLayer');
const Payment = require('../models/Payment');
const Product = require('../models/Product');
const kardex = require('../utils/kardex');

async function run() {
  const opts = parseArgs();
  const force = process.argv.slice(2).includes('--force');
  banner('Borrar TODAS las facturas de Compras (uso único)', opts);
  await connect();
  try {
    const scope = opts.clinic ? { clinic: new mongoose.Types.ObjectId(String(opts.clinic)) } : {};

    const invoices = await PurchaseInvoice.find(scope).select('_id clinic serie status items');
    const invoiceIds = invoices.map((i) => i._id);
    if (!invoiceIds.length) {
      console.log('No hay facturas de compra para borrar. Nada que hacer.');
      return;
    }

    const refScope = { ...scope, sourceModel: 'PurchaseInvoice', sourceRef: { $in: invoiceIds } };
    const [journalCount, payableCount, movCount, layerCount] = await Promise.all([
      JournalEntry.countDocuments({ ...scope, sourceModel: 'PurchaseInvoice', sourceRef: { $in: invoiceIds } }),
      Payable.countDocuments(refScope),
      InventoryMovement.countDocuments(refScope),
      InventoryLayer.countDocuments(refScope),
    ]);

    // Pagos que aplican a alguna de estas compras (quedarían colgados si se borran las facturas).
    const paymentsWithPurchase = await Payment.countDocuments({
      ...scope, 'applications.docModel': 'PurchaseInvoice', 'applications.docRef': { $in: invoiceIds },
    });

    // Productos afectados (para recalcular stock tras borrar las capas).
    const affectedProducts = new Set();
    for (const inv of invoices) for (const it of inv.items || []) if (it.product) affectedProducts.add(String(it.product));
    const layerProducts = await InventoryLayer.find(refScope).select('product');
    for (const l of layerProducts) if (l.product) affectedProducts.add(String(l.product));

    console.log('Se encontraron:');
    console.log(`  - Facturas de compra:        ${invoiceIds.length}`);
    console.log(`  - Asientos contables:        ${journalCount}`);
    console.log(`  - Documentos CxP (Payable):  ${payableCount}`);
    console.log(`  - Movimientos de inventario: ${movCount}`);
    console.log(`  - Capas kardex:              ${layerCount}`);
    console.log(`  - Productos a recalcular:    ${affectedProducts.size}`);
    if (paymentsWithPurchase) console.log(`  - ⚠ Pagos que aplican a estas compras: ${paymentsWithPurchase}`);

    if (opts.dryRun) {
      console.log('\nDRY-RUN: no se borró nada. Ejecuta con --commit para aplicar.');
      return;
    }

    if (paymentsWithPurchase && !force) {
      console.log('\n⛔ ABORTADO: hay pagos que aplican a estas compras. Anúlalos primero,');
      console.log('   o vuelve a ejecutar con --commit --force para borrar de todas formas.');
      return;
    }

    const [jr, pr, mr, lr, ir] = await Promise.all([
      JournalEntry.deleteMany({ ...scope, sourceModel: 'PurchaseInvoice', sourceRef: { $in: invoiceIds } }),
      Payable.deleteMany(refScope),
      InventoryMovement.deleteMany(refScope),
      InventoryLayer.deleteMany(refScope),
      PurchaseInvoice.deleteMany({ ...scope, _id: { $in: invoiceIds } }),
    ]);

    // Recalcula stock/costo de los productos afectados desde sus capas vivas restantes.
    let recalced = 0;
    for (const pid of affectedProducts) {
      const prod = await Product.findById(pid);
      if (!prod) continue;
      const cur = await kardex.currentStock({ clinicId: prod.clinic, product: prod._id });
      prod.stock = cur.qty;
      prod.averageCost = cur.averageCost;
      await prod.save();
      recalced++;
    }

    console.log('\n✅ HECHO:');
    console.log(`  - Facturas borradas:        ${ir.deletedCount}`);
    console.log(`  - Asientos borrados:        ${jr.deletedCount}`);
    console.log(`  - CxP borradas:             ${pr.deletedCount}`);
    console.log(`  - Movimientos borrados:     ${mr.deletedCount}`);
    console.log(`  - Capas kardex borradas:    ${lr.deletedCount}`);
    console.log(`  - Productos recalculados:   ${recalced}`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
