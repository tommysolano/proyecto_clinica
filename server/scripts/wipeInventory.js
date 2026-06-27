/**
 * Borrado TOTAL del inventario (uso único).
 *
 * Elimina todos los productos y su cadena de stock en TODAS las clínicas:
 *   - Product          (productos / servicios / programas)
 *   - InventoryLayer   (capas de kardex FIFO)
 *   - InventoryMovement(movimientos de inventario)
 *   - PhysicalCount    (conteos físicos)
 *
 * NO toca: bodegas, categorías contables, ventas, compras, cotizaciones ni
 * cualquier otro histórico transaccional (esos guardan su propio snapshot).
 *
 * Por seguridad NO borra nada salvo que se pase --commit.
 *
 *   node scripts/wipeInventory.js            (dry-run: solo cuenta)
 *   node scripts/wipeInventory.js --commit   (BORRA de verdad)
 *
 * Requiere MONGODB_URI en el entorno (.env o variable de entorno).
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Product = require('../models/Product');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryMovement = require('../models/InventoryMovement');
const PhysicalCount = require('../models/PhysicalCount');

const TARGETS = [
  ['Productos', Product],
  ['Capas de kardex (InventoryLayer)', InventoryLayer],
  ['Movimientos (InventoryMovement)', InventoryMovement],
  ['Conteos físicos (PhysicalCount)', PhysicalCount],
];

async function run() {
  const opts = parseArgs();
  banner('Borrado TOTAL del inventario', opts);
  await connect();
  try {
    for (const [label, Model] of TARGETS) {
      const count = await Model.countDocuments({});
      if (opts.commit) {
        const { deletedCount } = await Model.deleteMany({});
        console.log(`  🗑️  ${label}: ${deletedCount} eliminados (había ${count}).`);
      } else {
        console.log(`  • ${label}: ${count} documentos se eliminarían.`);
      }
    }
    console.log(
      opts.commit
        ? '\n✅  Inventario borrado por completo.'
        : '\nDRY-RUN: nada se borró. Ejecuta con --commit para aplicar.'
    );
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
