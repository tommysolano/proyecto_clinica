const mongoose = require('mongoose');

/**
 * Deducción a un empleado a recuperar vía rol de pagos. Cubre varios tipos:
 * - CONSUMO: el empleado adquirió productos/servicios de la clínica.
 * - MULTA: sanción/descuento disciplinario.
 * - UNIFORME: uniformes/EPP descontados.
 * - ANTICIPO: anticipo de sueldo entregado en efectivo/banco.
 * - OTRO: cualquier otro descuento.
 *
 * Al crearse genera un asiento (Debe CxC empleados / Haber cuenta contraparte).
 * Al cerrar el rol del período, el monto pendiente se descuenta del neto y se
 * acredita la CxC empleados (el empleado salda su deuda con su sueldo).
 */
const employeeDeductionSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true, index: true },
    type: { type: String, enum: ['CONSUMO', 'MULTA', 'UNIFORME', 'ANTICIPO', 'OTRO'], default: 'OTRO' },
    date: { type: Date, default: Date.now },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, default: '' },
    // Cuenta contraparte del asiento de creación (ingreso/caja/inventario, según el caso).
    counterpartAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    status: { type: String, enum: ['PENDIENTE', 'APLICADO', 'ANULADO'], default: 'PENDIENTE' },
    appliedIn: { type: String, default: '' }, // YYYY-MM del rol que la descontó
    appliedAt: Date,
    sourceModel: String,
    sourceRef: { type: mongoose.Schema.Types.ObjectId },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

employeeDeductionSchema.index({ clinic: 1, employee: 1, status: 1 });

module.exports = mongoose.model('EmployeeDeduction', employeeDeductionSchema);
