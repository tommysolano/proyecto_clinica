/** Auditoría de solo lectura de dos casos especiales del plan contable. */
const { connect, disconnect } = require('./_common');
const Sale = require('../models/Sale');
const FixedAsset = require('../models/FixedAsset');
const FiscalPeriod = require('../models/FiscalPeriod');

const monthIndex = (year, month) => Number(year) * 12 + Number(month) - 1;

async function diagnose() {
  const cardSales = await Sale.aggregate([
    { $match: { status: 'completada', 'payments.1': { $exists: true } } },
    { $project: { cardRows: { $size: { $filter: { input: '$payments', as: 'p',
      cond: { $eq: ['$$p.method', 'tarjeta'] } } } } } },
    { $group: { _id: null, mixedWithCard: { $sum: { $cond: [{ $gte: ['$cardRows', 1] }, 1, 0] } },
      multipleCardRows: { $sum: { $cond: [{ $gte: ['$cardRows', 2] }, 1, 0] } } } },
  ]);
  const assets = await FixedAsset.find({ status: 'ACTIVO', monthlyDepreciation: { $gt: 0 } })
    .select('clinic startDate lastDepreciationPeriod acquisitionCost residualValue accumulatedDepreciation').lean();
  const closed = await FiscalPeriod.find({ status: { $ne: 'ABIERTO' } })
    .select('clinic year month').lean();
  const byClinic = new Map();
  for (const p of closed) {
    const key = String(p.clinic);
    if (!byClinic.has(key)) byClinic.set(key, []);
    byClinic.get(key).push(monthIndex(p.year, p.month));
  }
  const pendingInClosedPeriods = assets.filter((asset) => {
    if (Number(asset.acquisitionCost) - Number(asset.residualValue || 0) - Number(asset.accumulatedDepreciation || 0) <= 0.01) return false;
    const next = asset.lastDepreciationPeriod
      ? monthIndex(asset.lastDepreciationPeriod.slice(0, 4), asset.lastDepreciationPeriod.slice(5, 7)) + 1
      : monthIndex(new Date(asset.startDate).getFullYear(), new Date(asset.startDate).getMonth() + 1);
    return (byClinic.get(String(asset.clinic)) || []).some((period) => period >= next);
  }).length;
  return { mixedPaymentSalesWithCard: cardSales[0]?.mixedWithCard || 0,
    multipleCardRowsSales: cardSales[0]?.multipleCardRows || 0,
    activeDepreciableAssets: assets.length, pendingInClosedPeriods };
}

if (require.main === module) {
  connect().then(async () => { console.log(JSON.stringify(await diagnose(), null, 2)); })
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(disconnect);
}

module.exports = { diagnose };
