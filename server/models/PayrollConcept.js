const mongoose = require('mongoose');

/**
 * Catálogo de RUBROS de nómina (conceptos). El usuario agrega rubros al rol por
 * código; el backend resuelve la cuenta desde el concepto (nunca cuenta manual):
 *  - INGRESO:    debita `defaultAccount` (gasto) si está definido; si no, va a la
 *                cuenta de sueldos del departamento.
 *  - EGRESO:     acredita `payableAccount` (obligación/CxC del empleado).
 *  - PROVISION:  debita `defaultAccount` (gasto) y acredita `payableAccount` (por pagar).
 *  - OBLIGACION: acredita `payableAccount`.
 *
 * `rate` es un porcentaje CONFIGURABLE (no se hardcodea la ley). Los flags
 * `affects*` indican si el rubro entra a la base de IESS / décimos / impuesto renta.
 */
const payrollConceptSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    type: { type: String, enum: ['INGRESO', 'EGRESO', 'PROVISION', 'OBLIGACION'], required: true },
    // Subcategoría libre para agrupar en la UI (p.ej. HORAS_EXTRAS, PRESTAMO, BONO).
    category: { type: String, default: '' },
    // Base imponible / cálculo (configurable, no hardcodeado).
    rate: { type: Number, default: 0 }, // % opcional (horas extra, aportes, etc.)
    affectsIess: { type: Boolean, default: false },
    affectsDecimos: { type: Boolean, default: false },
    affectsIncomeTax: { type: Boolean, default: false },
    isReimbursement: { type: Boolean, default: false }, // reembolso: no es ingreso gravado
    // Cuentas (refs al plan). El rol NUNCA pide cuenta manual: sale de aquí.
    defaultAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null }, // gasto (INGRESO/PROVISION)
    payableAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null }, // por pagar / CxC (EGRESO/PROVISION/OBLIGACION)
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

payrollConceptSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('PayrollConcept', payrollConceptSchema);
