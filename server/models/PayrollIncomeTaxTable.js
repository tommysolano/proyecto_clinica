const mongoose = require('mongoose');

/**
 * Tabla de impuesto a la renta parametrizable POR AÑO y clínica. Reemplaza la
 * tabla hardcodeada: el cálculo del IR busca la tabla ACTIVA de la clínica/año.
 * Los rangos son configurables (el contador debe validar los valores vigentes).
 *
 * `periodType`:
 *   - ANNUAL  → los rangos aplican a la base ANUAL; el IR mensual = IR anual / 12.
 *   - MONTHLY → los rangos aplican a la base MENSUAL; el IR es directo.
 *
 * Rango: base > `from` y (base <= `to` o `to` nulo = último tramo).
 * IR = `baseTax` + (base − `from`) × `excessRate`/100.
 */
const rangeSchema = new mongoose.Schema(
  {
    from: { type: Number, required: true, default: 0 },
    to: { type: Number, default: null }, // null = sin tope (último tramo)
    baseTax: { type: Number, default: 0 },
    excessRate: { type: Number, default: 0 }, // % sobre el excedente de `from`
  },
  { _id: false }
);

const payrollIncomeTaxTableSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    year: { type: Number, required: true },
    periodType: { type: String, enum: ['MONTHLY', 'ANNUAL'], default: 'ANNUAL' },
    ranges: { type: [rangeSchema], default: [] },
    active: { type: Boolean, default: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

// Una sola tabla ACTIVA por clínica/año (permite versiones inactivas históricas).
payrollIncomeTaxTableSchema.index(
  { clinic: 1, year: 1, active: 1 },
  { unique: true, partialFilterExpression: { active: true } }
);

module.exports = mongoose.model('PayrollIncomeTaxTable', payrollIncomeTaxTableSchema);
