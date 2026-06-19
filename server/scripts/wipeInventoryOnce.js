/**
 * USO ÚNICO — Borra TODO el inventario (todas las sucursales) y se autodestruye.
 *
 * Borra por completo, en TODAS las clínicas:
 *   - Product           (catálogo / lista de inventario)
 *   - InventoryMovement (historial de movimientos de stock)
 *   - InventoryLayer    (capas de costo / lotes del kardex)
 *
 * NO toca: bodegas (Warehouse), categorías (InventoryCategory), ni ventas,
 * facturas o asientos contables históricos.
 *
 * Pensado para ejecutarse UNA sola vez (p. ej. tras un git push / deploy) antes
 * de re-importar el catálogo correcto por Excel. Al terminar con --commit, el
 * script se borra a sí mismo para que no vuelva a ejecutarse nunca.
 *
 *   node scripts/wipeInventoryOnce.js            (DRY-RUN: solo cuenta, no borra)
 *   node scripts/wipeInventoryOnce.js --commit   (BORRA de verdad y se autodestruye)
 */
const fs = require('fs');
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryLayer = require('../models/InventoryLayer');

async function run() {
  const opts = parseArgs();
  banner('BORRADO TOTAL DEL INVENTARIO (uso único)', opts);
  await connect();
  try {
    const [products, movements, layers] = await Promise.all([
      Product.countDocuments({}),
      InventoryMovement.countDocuments({}),
      InventoryLayer.countDocuments({}),
    ]);

    console.log('Se borrará (todas las sucursales):');
    console.log(`  - Productos:              ${products}`);
    console.log(`  - Movimientos de stock:   ${movements}`);
    console.log(`  - Capas de costo (lotes): ${layers}`);
    console.log('');

    if (opts.dryRun) {
      console.log('DRY-RUN: no se borró nada. Ejecuta con --commit para aplicar.');
      return;
    }

    const r1 = await Product.deleteMany({});
    const r2 = await InventoryMovement.deleteMany({});
    const r3 = await InventoryLayer.deleteMany({});

    console.log('BORRADO COMPLETADO:');
    console.log(`  - Productos borrados:              ${r1.deletedCount}`);
    console.log(`  - Movimientos borrados:           ${r2.deletedCount}`);
    console.log(`  - Capas de costo borradas:        ${r3.deletedCount}`);
    console.log('');

    // Autodestrucción: el script no debe volver a ejecutarse jamás.
    try {
      fs.unlinkSync(__filename);
      console.log(`Script autodestruido: ${__filename}`);
      console.log('Recuerda confirmar su eliminación en git (commit) para quitarlo del repositorio.');
    } catch (e) {
      console.warn(`No se pudo autodestruir el script (${e.message}). Bórralo manualmente: ${__filename}`);
    }
  } finally {
    await disconnect();
  }
}

run().catch((err) => {
  console.error('ERROR:', err.message);
  process.exit(1);
});
