/**
 * Activa los SÁBADOS (includeSaturdays = true) en la configuración de flujo de caja de las
 * clínicas que aún los tengan apagados. La contadora quiere el calendario de lunes a sábado
 * (el domingo se sigue proyectando al lunes). El default del modelo ya es `true`; esto solo
 * corrige las CONFIGS EXISTENTES creadas antes de ese default.
 *
 * Idempotente. Uso:
 *   node scripts/migrateCashFlowSaturdays.js           (dry-run: solo muestra)
 *   node scripts/migrateCashFlowSaturdays.js --commit  (aplica los cambios)
 *
 * OJO: el .env local apunta a la base de PRODUCCIÓN. Correr con --commit desde local afecta
 * prod: preferir ejecutarlo en el VPS.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const CashFlowConfig = require('../models/CashFlowConfig');

async function main() {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(process.env.MONGODB_URI);
  const configs = await CashFlowConfig.find({ includeSaturdays: { $ne: true } });
  console.log(`Configuraciones con sábados apagados: ${configs.length}`);
  for (const c of configs) {
    console.log(` - clínica ${c.clinic}: includeSaturdays ${c.includeSaturdays} -> true`);
    if (commit) { c.includeSaturdays = true; await c.save(); }
  }
  console.log(commit ? '✔ Aplicado.' : 'Dry-run. Usa --commit para aplicar.');
  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
