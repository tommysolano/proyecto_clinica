/**
 * Siembra la tabla de impuesto a la renta (rangos SRI 2024 por defecto) por clínica
 * para un año dado, SOLO si no existe una tabla activa. Idempotente.
 * ADVERTENCIA: los valores son una semilla; el contador DEBE validar los vigentes.
 * Dry-run por defecto; --commit para aplicar. --year=YYYY (por defecto año actual).
 *
 *   node scripts/seedPayrollIncomeTax.js
 *   node scripts/seedPayrollIncomeTax.js --year=2026 --commit
 *   node scripts/seedPayrollIncomeTax.js --clinic=<id> --year=2026 --commit
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Clinic = require('../models/Clinic');
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');
const { DEFAULT_IR_RANGES_2024 } = require('../utils/payrollTax');

async function run() {
  const opts = parseArgs();
  const yearArg = process.argv.find((a) => a.startsWith('--year='));
  const year = yearArg ? parseInt(yearArg.split('=')[1], 10) : new Date().getFullYear();
  banner(`Seed tabla IR ${year}`, opts);
  console.log('ADVERTENCIA: rangos SRI 2024 (semilla). Validar los valores vigentes del año.\n');
  await connect();
  try {
    const clinics = opts.clinic ? [{ _id: opts.clinic }] : await Clinic.find().select('_id name');
    let created = 0;
    for (const c of clinics) {
      const exists = await PayrollIncomeTaxTable.findOne({ clinic: c._id, year, active: true });
      if (exists) { console.log(`Clínica ${c.name || c._id}: ya tiene tabla ${year} activa (sin cambios).`); continue; }
      console.log(`Clínica ${c.name || c._id}: ${opts.commit ? 'creando' : 'crearía'} tabla IR ${year}.`);
      if (opts.commit) {
        await PayrollIncomeTaxTable.create({ clinic: c._id, year, periodType: 'ANNUAL', active: true, ranges: DEFAULT_IR_RANGES_2024, notes: 'Semilla SRI 2024. Validar valores vigentes.' });
      }
      created += 1;
    }
    console.log(`\nTablas ${opts.commit ? 'creadas' : 'a crear'}: ${created}`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
