/**
 * Migración: inventario actual → capas de kardex (InventoryLayer).
 *
 * Para cada producto físico con stock > 0 que aún NO tenga capas, crea una capa
 * inicial con qtyRemaining = stock y unitCost = averageCost (o purchasePrice).
 * Idempotente: si el producto ya tiene capas, lo salta.
 *
 *   node scripts/migrateInventoryToLayers.js            (dry-run)
 *   node scripts/migrateInventoryToLayers.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Product = require('../models/Product');
const InventoryLayer = require('../models/InventoryLayer');

async function run() {
  const opts = parseArgs();
  banner('Migración inventario → capas (kardex)', opts);
  await connect();
  try {
    const filter = { stock: { $gt: 0 }, unlimited: { $ne: true }, category: { $ne: 'servicio' } };
    if (opts.clinic) filter.clinic = opts.clinic;
    const products = await Product.find(filter);

    let created = 0, skipped = 0;
    for (const p of products) {
      const existing = await InventoryLayer.countDocuments({ clinic: p.clinic, product: p._id });
      if (existing > 0) { skipped++; continue; }
      const unitCost = Number(p.averageCost || p.purchasePrice || 0);
      console.log(`  + Capa inicial ${p.code} "${p.name}": ${p.stock} u @ ${unitCost}`);
      if (opts.commit) {
        await InventoryLayer.create({
          clinic: p.clinic, product: p._id, warehouse: null, lot: '', expiryDate: null,
          qtyInitial: p.stock, qtyRemaining: p.stock, unitCost,
          date: new Date(), sourceModel: 'Migration', sourceRef: null,
        });
      }
      created++;
    }
    console.log(`\nProductos con capa creada: ${created}. Saltados (ya tenían capas): ${skipped}.`);
    if (opts.dryRun) console.log('DRY-RUN: nada se escribió.');
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
