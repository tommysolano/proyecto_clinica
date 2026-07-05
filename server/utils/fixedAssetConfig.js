/**
 * Configuración contable y de depreciación de un activo fijo DERIVADA de su categoría
 * (InventoryCategory kind ACTIVO_FIJO). La categoría es la ÚNICA fuente: en compras y en
 * creación manual el usuario NO edita cuentas ni parámetros; se copian de aquí como
 * snapshot al activo. Ver [[modelos: InventoryCategory, FixedAsset]].
 */

function idOf(v) { return v && typeof v === 'object' ? (v._id || v) : (v || null); }

/**
 * Normaliza la configuración de una categoría de activo fijo. Deriva la vida útil en
 * meses desde `usefulLifeMonths` (o `usefulLifeYears*12` legacy) y completa la tasa de
 * depreciación / vida útil que falte. Terrenos u otras categorías `noDepreciate` quedan
 * con vida útil y tasa en 0.
 */
function normalizeAssetConfig(cat) {
  if (!cat) return null;
  const noDepreciate = !!cat.noDepreciate;
  let usefulLifeMonths = Number(cat.usefulLifeMonths) > 0
    ? Math.round(Number(cat.usefulLifeMonths))
    : (Number(cat.usefulLifeYears) > 0 ? Math.round(Number(cat.usefulLifeYears) * 12) : 0);
  let depreciationRate = Number(cat.depreciationRate) || 0;
  if (noDepreciate) {
    usefulLifeMonths = 0; depreciationRate = 0;
  } else {
    if (!usefulLifeMonths && depreciationRate > 0) usefulLifeMonths = Math.round(1200 / depreciationRate);
    if (!depreciationRate && usefulLifeMonths > 0) depreciationRate = +(1200 / usefulLifeMonths).toFixed(4);
  }
  return {
    assetAccount: idOf(cat.assetAccount),
    depreciationAccount: idOf(cat.depreciationAccount),
    accumDepreciationAccount: idOf(cat.accumDepreciationAccount),
    usefulLifeMonths,
    residualPercent: Number(cat.residualPercent) || 0,
    depreciationRate,
    expenseType: cat.expenseType || '',
    noDepreciate,
  };
}

/**
 * Lista de campos faltantes/ inválidos de una categoría de activo fijo (para bloquear su
 * guardado y la contabilización de compras). Una categoría depreciable exige cuentas de
 * activo, gasto de depreciación y depreciación acumulada, vida útil, % residual válido y
 * tipo de gasto. Terrenos (`noDepreciate`) solo exigen cuenta de activo.
 */
function assetCategoryIssues(cat) {
  const cfg = normalizeAssetConfig(cat);
  const issues = [];
  if (!cfg || !cfg.assetAccount) issues.push('cuenta de activo');
  if (cfg && !cfg.noDepreciate) {
    if (!cfg.depreciationAccount) issues.push('cuenta de gasto de depreciación');
    if (!cfg.accumDepreciationAccount) issues.push('cuenta de depreciación acumulada');
    if (!(cfg.usefulLifeMonths > 0)) issues.push('vida útil (meses)');
    if (!(cfg.residualPercent >= 0 && cfg.residualPercent <= 100)) issues.push('% residual (0–100)');
    if (!cfg.expenseType) issues.push('tipo de gasto');
  }
  return issues;
}

module.exports = { idOf, normalizeAssetConfig, assetCategoryIssues };
