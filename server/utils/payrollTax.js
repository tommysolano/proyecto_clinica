/**
 * Cálculo del impuesto a la renta a partir de una tabla PARAMETRIZABLE
 * (PayrollIncomeTaxTable), no hardcodeada. El módulo de nómina busca la tabla
 * activa por clínica/año; si no existe, el cierre se bloquea (no se calcula con
 * valores obsoletos en silencio).
 */
const PayrollIncomeTaxTable = require('../models/PayrollIncomeTaxTable');

/**
 * Rangos por defecto (SRI 2024, ANUAL) SOLO como semilla inicial. El contador
 * DEBE validar/actualizar los valores vigentes cada año.
 */
const DEFAULT_IR_RANGES_2024 = [
  { from: 0, to: 11722, baseTax: 0, excessRate: 0 },
  { from: 11722, to: 14930, baseTax: 0, excessRate: 5 },
  { from: 14930, to: 19385, baseTax: 160, excessRate: 10 },
  { from: 19385, to: 25638, baseTax: 606, excessRate: 12 },
  { from: 25638, to: 33738, baseTax: 1356, excessRate: 15 },
  { from: 33738, to: 44721, baseTax: 2571, excessRate: 20 },
  { from: 44721, to: 59537, baseTax: 4768, excessRate: 25 },
  { from: 59537, to: 79388, baseTax: 8472, excessRate: 30 },
  { from: 79388, to: 105580, baseTax: 14427, excessRate: 35 },
  { from: 105580, to: null, baseTax: 23594, excessRate: 37 },
];

/**
 * Calcula el impuesto sobre `base` según los rangos de la tabla.
 * @returns {number|null} impuesto (0..∞); `null` si no hay tabla utilizable.
 */
function computeIncomeTax(base, table) {
  if (!table || !Array.isArray(table.ranges) || !table.ranges.length) return null;
  const b = Math.max(0, Number(base) || 0);
  const ranges = [...table.ranges].sort((a, b2) => (a.from || 0) - (b2.from || 0));
  for (const r of ranges) {
    const from = Number(r.from) || 0;
    const to = r.to == null ? Infinity : Number(r.to);
    if (b > from && b <= to) {
      return Math.max(0, +(r.baseTax + (b - from) * (r.excessRate / 100)).toFixed(2));
    }
  }
  return 0; // base <= piso del primer tramo → sin impuesto
}

/** Tabla de IR ACTIVA para la clínica/año (o null). */
async function getActiveIncomeTaxTable(clinicId, year, options = {}) {
  return PayrollIncomeTaxTable.findOne({ clinic: clinicId, year, active: true }).session(options.session || null);
}

module.exports = { DEFAULT_IR_RANGES_2024, computeIncomeTax, getActiveIncomeTaxTable };
