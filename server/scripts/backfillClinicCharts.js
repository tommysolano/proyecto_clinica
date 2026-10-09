/**
 * Lista sucursales activas sin plan propio y permite sembrar el plan clinico.
 * Las sucursales enlazadas a un centro contable leen el plan de su sucursal
 * contable y se excluyen. Por defecto solo muestra el alcance.
 *
 * node scripts/backfillClinicCharts.js [--clinic=<id>]
 * node scripts/backfillClinicCharts.js --clinic=<id> --commit
 */
const { parseArgs, connect, disconnect } = require('./_common');
const Clinic = require('../models/Clinic');
const ChartOfAccount = require('../models/ChartOfAccount');
const { runInTransaction, seedChartOfAccounts } = require('../utils/accounting');

async function backfill({ clinic = null, commit = false } = {}) {
  const filter = { active: { $ne: false }, accountingCostCenter: null };
  if (clinic) filter._id = clinic;
  const clinics = await Clinic.find(filter).select('_id company').lean();
  const result = [];
  for (const row of clinics) {
    const existing = await ChartOfAccount.countDocuments({ clinic: row._id });
    const item = { clinic: String(row._id), company: String(row.company || ''),
      existing, action: existing ? 'REVIEW_EXISTING_CHART' : commit ? 'SEEDED' : 'WOULD_SEED' };
    if (commit && !existing) {
      item.seed = await runInTransaction((session) => seedChartOfAccounts(row._id, { session }));
    }
    result.push(item);
  }
  return result;
}

if (require.main === module) {
  const args = parseArgs();
  connect().then(async () => { console.log(JSON.stringify(await backfill(args), null, 2)); })
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(disconnect);
}

module.exports = { backfill };
