/**
 * wipe-products.js  —  BORRADO TOTAL DE PRODUCTOS E INVENTARIO
 *
 * Elimina, en TODAS las clínicas:
 *   - Product            (catálogo de productos/servicios/programas)
 *   - InventoryLayer     (capas FIFO del kardex)
 *   - InventoryMovement  (movimientos de inventario)
 *
 * ⚠️  ES IRREVERSIBLE. No hay papelera ni undo. Haz un respaldo de la BD antes.
 *
 * 🔒  ESTÁ DESACTIVADO A PROPÓSITO. Aunque uses --commit, NO borrará nada a menos
 *     que actives el interruptor con la variable de entorno  WIPE_ENABLED=1.
 *     Así queda guardado por si se necesita en el futuro, sin riesgo de
 *     ejecutarlo por accidente.
 *
 * Uso:
 *   node wipe-products.js                          → SIMULACIÓN: solo cuenta.
 *   WIPE_ENABLED=1 node wipe-products.js --commit  → BORRA de verdad.
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
// Interruptor de seguridad: el script queda INACTIVO salvo que se active aquí.
const ENABLED = process.env.WIPE_ENABLED === '1';

if (!MONGODB_URI) {
  console.error('❌  Falta MONGODB_URI en las variables de entorno.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log(`✅  Conectado a MongoDB → cluster: ${mongoose.connection.host}  ·  base: ${mongoose.connection.name}`);

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
    console.log('    Para borrar de verdad (script desactivado por defecto):');
    console.log('       WIPE_ENABLED=1 node wipe-products.js --commit\n');
    await mongoose.disconnect();
    return;
  }

  // Interruptor de seguridad: bloquea el borrado salvo que se active a propósito.
  if (!ENABLED) {
    console.log('\n🔒  Script DESACTIVADO. No se borró nada.');
    console.log('    Para activarlo, exporta WIPE_ENABLED=1 antes de --commit:');
    console.log('       WIPE_ENABLED=1 node wipe-products.js --commit\n');
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
