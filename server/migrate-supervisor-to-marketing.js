/**
 * migrate-supervisor-to-marketing.js
 *
 * Convierte todos los roles 'supervisor_call_center' a 'marketing' en las
 * asignaciones de clínica de cada usuario. El rol supervisor fue eliminado y
 * su funcionalidad (supervisar al call center) la asumió 'marketing'.
 *
 *   node migrate-supervisor-to-marketing.js
 *
 * Requiere MONGODB_URI en .env o variable de entorno.
 */

require('dotenv').config();
const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('❌  Falta MONGODB_URI en las variables de entorno.');
  process.exit(1);
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  console.log('✅  Conectado a MongoDB');

  const res = await mongoose.connection.db.collection('users').updateMany(
    { 'clinics.role': 'supervisor_call_center' },
    { $set: { 'clinics.$[elem].role': 'marketing' } },
    { arrayFilters: [{ 'elem.role': 'supervisor_call_center' }] }
  );

  console.log(`✅  Usuarios migrados: ${res.modifiedCount}`);
  await mongoose.disconnect();
  console.log('✅  Listo.');
}

main().catch((err) => {
  console.error('❌  Error:', err.message);
  process.exit(1);
});
