/**
 * Marca los roles de nómina EXISTENTES con periodType = 'MENSUAL' (los que se generaron antes de
 * la nómina quincenal no tienen el campo). El default del modelo ya es 'MENSUAL'; esto fija el
 * valor explícito para que el índice único { clinic, year, month, periodType } no colisione y para
 * que las consultas por periodType los encuentren.
 *
 * Además REPORTA (no corrige automáticamente) los roles con año absurdo (fuera de 2000–2100),
 * que es la causa del error "No hay tabla de impuesto a la renta configurada para el año 1926":
 * un año corrupto no se puede adivinar, así que se listan para revisarlos/anularlos a mano.
 *
 * Idempotente. Uso:
 *   node scripts/migratePayrollPeriodType.js           (dry-run: solo muestra)
 *   node scripts/migratePayrollPeriodType.js --commit  (aplica los cambios)
 *
 * OJO: el .env local apunta a la base de PRODUCCIÓN. Correr con --commit desde local afecta prod:
 * preferir ejecutarlo en el VPS.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Payroll = require('../models/Payroll');

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);

  // 1) Roles sin periodType → 'MENSUAL'.
  const faltante = { $or: [{ periodType: { $exists: false } }, { periodType: { $in: [null, ''] } }] };
  const total = await Payroll.countDocuments(faltante);
  console.log(`Roles sin periodType (a marcar como MENSUAL): ${total}`);
  if (commit && total) {
    const r = await Payroll.updateMany(faltante, { $set: { periodType: 'MENSUAL' } });
    console.log(`  → actualizados: ${r.modifiedCount}`);
  }

  // 2) Reporte de años absurdos (no se tocan: se listan para revisión manual).
  const absurdos = await Payroll.find({ $or: [{ year: { $lt: 2000 } }, { year: { $gt: 2100 } }] })
    .select('code year month period status').lean();
  if (absurdos.length) {
    console.log(`\n⚠ Roles con AÑO ABSURDO (revísalos/anúlalos a mano — causa del error de tabla IR):`);
    for (const p of absurdos) {
      console.log(`  - ${p.code || p._id} · año ${p.year} mes ${p.month} · period ${p.period} · ${p.status}`);
    }
  } else {
    console.log('\nSin roles con año absurdo. 👍');
  }

  console.log(commit ? '\n✔ Aplicado.' : '\nDry-run. Usa --commit para aplicar.');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
