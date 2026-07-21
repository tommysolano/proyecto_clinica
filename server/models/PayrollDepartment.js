const mongoose = require('mongoose');

/**
 * Departamento de nómina parametrizado. El `type` clasifica el gasto de sueldos
 * de sus empleados en el Estado de Resultados (Administrativo/Ventas/Costos/Otro)
 * y `accounts` define las cuentas de gasto que debita el cierre de rol. Si una
 * cuenta no está configurada, el cierre cae a la cuenta general de PayrollConfig.
 */
const payrollDepartmentSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    // Clasificación funcional del gasto (define a qué grupo del P&L va y la clave de las cuentas
    // por departamento). 'OTROS' es el estándar; 'OTRO' se conserva por compatibilidad legacy.
    type: { type: String, enum: ['ADMINISTRATIVO', 'VENTAS', 'COSTOS', 'OTROS', 'OTRO'], default: 'ADMINISTRATIVO' },
    // Cuentas de GASTO de este departamento (refs al plan). Opcionales: si faltan,
    // el cierre usa las cuentas generales de PayrollConfig (compat legacy).
    accounts: {
      sueldos: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
      beneficios: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
      iessPatronal: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    },
    active: { type: Boolean, default: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

payrollDepartmentSchema.index({ clinic: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('PayrollDepartment', payrollDepartmentSchema);
