/**
 * Siembra el catálogo estándar de conceptos de nómina (rubros) por clínica.
 * Idempotente: no duplica códigos ya existentes. Sin cuentas asignadas (el
 * contador las mapea en la UI). Dry-run por defecto; --commit para aplicar.
 *
 *   node scripts/seedPayrollConcepts.js
 *   node scripts/seedPayrollConcepts.js --commit
 *   node scripts/seedPayrollConcepts.js --clinic=<id> --commit
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Clinic = require('../models/Clinic');
const PayrollConcept = require('../models/PayrollConcept');
const { STANDARD_CONCEPTS } = require('../controllers/payrollController');

async function run() {
  const opts = parseArgs();
  banner('Seed conceptos de nómina', opts);
  await connect();
  try {
    const clinics = opts.clinic ? [{ _id: opts.clinic }] : await Clinic.find().select('_id name');
    let totalCreated = 0;
    for (const c of clinics) {
      const existing = await PayrollConcept.find({ clinic: c._id }).select('code');
      const have = new Set(existing.map((x) => x.code));
      const toCreate = STANDARD_CONCEPTS.filter((x) => !have.has(x.code));
      console.log(`Clínica ${c.name || c._id}: ${existing.length} existentes, ${toCreate.length} a crear`);
      if (opts.commit && toCreate.length) {
        await PayrollConcept.insertMany(toCreate.map((x) => ({ ...x, clinic: c._id })));
      }
      totalCreated += toCreate.length;
    }
    console.log(`\nTotal conceptos ${opts.commit ? 'creados' : 'a crear'}: ${totalCreated}`);
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error(e); process.exit(1); });
