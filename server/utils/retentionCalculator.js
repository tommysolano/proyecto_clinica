/**
 * Cálculo PURO de retenciones por línea (sin acceso a DB, para poder testear aislado).
 * El backend SIEMPRE recalcula base/monto con estas funciones a partir de la línea y la
 * regla; nunca confía en los valores enviados por el frontend.
 *
 * Codificación de `ivaRate` en las líneas de compra (igual que calcTotals):
 *   0, 12, 15 = tarifas; -1 = no objeto de IVA; -2 = exento.
 */

const round2 = (n) => +(+n || 0).toFixed(2);

/** Subtotal (base gravable antes de IVA) de una línea. */
function lineBase(it) {
  const b = it.subtotal != null
    ? Number(it.subtotal)
    : ((Number(it.quantity) || 0) * (Number(it.unitPrice) || 0) - (Number(it.discount) || 0));
  return round2(b);
}

/** Monto de IVA de una línea (usa `ivaAmount` si viene; si no, lo deriva de la tarifa). */
function lineIva(it) {
  if (it.ivaAmount != null && Number(it.ivaAmount) > 0) return round2(it.ivaAmount);
  const rate = Number(it.ivaRate);
  if (rate > 0) return round2(lineBase(it) * (rate / 100));
  return 0;
}

/** Base de retención según el `baseType` de la regla. */
function computeRetentionBase(it, baseType) {
  const base = lineBase(it);
  const rate = Number(it.ivaRate);
  switch (baseType) {
    case 'IVA':
      return lineIva(it);
    case 'SUBTOTAL_IVA':
      return rate > 0 ? base : 0; // solo líneas gravadas (12/15)
    case 'SUBTOTAL_0':
      return rate === 0 ? base : 0; // solo líneas 0%
    case 'SUBTOTAL_TOTAL':
    default:
      return base;
  }
}

/**
 * Calcula { base, amount } de una retención para una línea dada una regla.
 * Valida: base >= 0, rate en [0,100], monto <= base.
 */
function computeRetention(it, rule) {
  const base = round2(computeRetentionBase(it, rule.baseType));
  if (base < 0) throw Object.assign(new Error('La base de retención no puede ser negativa'), { status: 400 });
  const rate = Number(rule.rate);
  if (!(rate >= 0 && rate <= 100)) throw Object.assign(new Error('El porcentaje de retención debe estar entre 0 y 100'), { status: 400 });
  const amount = round2(base * (rate / 100));
  if (amount > base + 0.01) throw Object.assign(new Error('El monto de retención no puede superar la base'), { status: 400 });
  return { base, amount };
}

/**
 * Agrupa las retenciones de las líneas por (type, code, account) para el resumen /
 * cabecera. Devuelve filas con los campos que consumen los reportes (baseAmount,
 * percentage, amount) más `account`/`rule` para contabilizar.
 */
function groupLineRetentions(items) {
  const map = new Map();
  for (const it of items || []) {
    const r = it.retention;
    if (!r || !(Number(r.amount) > 0)) continue;
    const acc = r.account ? String(r.account) : '';
    const key = `${r.type}|${r.code}|${acc}`;
    if (!map.has(key)) {
      map.set(key, {
        type: r.type,
        code: r.code || '',
        description: r.description || '',
        rate: Number(r.rate) || Number(r.percentage) || 0,
        percentage: Number(r.rate) || Number(r.percentage) || 0,
        base: 0,
        baseAmount: 0,
        amount: 0,
        account: r.account || null,
        rule: r.rule || null,
      });
    }
    const g = map.get(key);
    g.base = round2(g.base + (Number(r.base) || Number(r.baseAmount) || 0));
    g.baseAmount = g.base;
    g.amount = round2(g.amount + (Number(r.amount) || 0));
  }
  return [...map.values()];
}

module.exports = { round2, lineBase, lineIva, computeRetentionBase, computeRetention, groupLineRetentions };
