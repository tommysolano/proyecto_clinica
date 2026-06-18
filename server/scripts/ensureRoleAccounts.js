/**
 * Migración: garantiza que cada clínica tenga las cuentas de los roles contables
 * usados por la contabilidad automática (incluye los nuevos, p.ej. Ingresos
 * diferidos). Crea las que falten desde el plan estándar (ensureAccountByCode).
 * Idempotente.
 *
 *   node scripts/ensureRoleAccounts.js            (dry-run)
 *   node scripts/ensureRoleAccounts.js --commit   (aplica)
 */
const { parseArgs, connect, disconnect, banner } = require('./_common');
const Clinic = require('../models/Clinic');
const ChartOfAccount = require('../models/ChartOfAccount');
const { ACCOUNT_ROLES } = require('../utils/accountMap');
const { ensureAccountByCode } = require('../utils/accounting');

async function run() {
  const opts = parseArgs();
  banner('Asegurar cuentas por rol en cada clínica', opts);
  await connect();
  try {
    const clinics = opts.clinic ? await Clinic.find({ _id: opts.clinic }) : await Clinic.find({});
    const codeRoles = Object.entries(ACCOUNT_ROLES).filter(([, def]) => def.code);

    let totalCreated = 0;
    for (const clinic of clinics) {
      let created = 0;
      for (const [role, def] of codeRoles) {
        const exists = await ChartOfAccount.findOne({ clinic: clinic._id, code: def.code });
        if (exists) continue;
        console.log(`  [${clinic.name || clinic._id}] falta ${def.code} (${role})`);
        if (opts.commit) await ensureAccountByCode(clinic._id, def.code);
        created++;
      }
      if (created) console.log(`  → ${clinic.name || clinic._id}: ${created} cuenta(s) ${opts.commit ? 'creadas' : 'por crear'}`);
      totalCreated += created;
    }
    console.log(`\nTotal cuentas ${opts.commit ? 'creadas' : 'faltantes'}: ${totalCreated} en ${clinics.length} clínica(s).`);
    if (opts.dryRun) console.log('DRY-RUN: nada se escribió.');
  } finally {
    await disconnect();
  }
}

run().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
