/**
 * wipe-products.js  —  BORRADO TOTAL DE PRODUCTOS E INVENTARIO (un solo uso)
 *
 * Elimina, en TODAS las clínicas:
 *   - Product            (catálogo de productos/servicios/programas)
 *   - InventoryLayer     (capas FIFO del kardex)
 *   - InventoryMovement  (movimientos de inventario)
 *
 * ⚠️  ES IRREVERSIBLE. No hay papelera ni undo. Haz un respaldo de la BD antes.
 *
 * Uso:
 *   node wipe-products.js            → SIMULACIÓN: solo muestra cuántos borraría.
 *   node wipe-products.js --commit   → BORRA de verdad.
 *
 * Requiere MONGODB_URI en .env o como variable de entorno.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const Product = require('./models/Product');
const InventoryLayer = require('./models/InventoryLayer');
const InventoryMovement = require('./models/InventoryMovement');

const MONGODB_URI = process.env.MONGODB_URI;
const COMMIT = process.argv.includes('--commit');

if (!MONGODB_URI) {
  console.error('❌  Falta MONGODB_URI en las variables de entorno.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅  Conectado a MongoDB');

  const collections = [
    { label: 'Productos (Product)', model: Product },
    { label: 'Capas FIFO (InventoryLayer)', model: InventoryLayer },
    { label: 'Movimientos (InventoryMovement)', model: InventoryMovement },
  ];

  // Conteo previo.
  console.log('\n📦  Registros actuales (todas las clínicas):');
  const counts = [];
  for (const c of collections) {
    const n = await c.model.countDocuments({});
    counts.push(n);
    console.log(`   • ${c.label.padEnd(34)} ${n}`);
  }
  const total = counts.reduce((a, b) => a + b, 0);

  if (!COMMIT) {
    console.log(`\n🟡  SIMULACIÓN: se borrarían ${total} registros en total.`);
    console.log('    Vuelve a ejecutar con  --commit  para borrar de verdad:');
    console.log('       node wipe-products.js --commit\n');
    await mongoose.disconnect();
    return;
  }

  // Borrado real.
  console.log('\n🔴  BORRANDO (--commit)…');
  for (const c of collections) {
    const { deletedCount } = await c.model.deleteMany({});
    console.log(`   • ${c.label.padEnd(34)} ${deletedCount} borrados`);
  }

  console.log('\n✅  Listo. Inventario vaciado por completo.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
