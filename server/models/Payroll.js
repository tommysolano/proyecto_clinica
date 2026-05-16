const mongoose = require('mongoose');

const payrollItemSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeName: String,
    identificacion: String,
    daysWorked: { type: Number, default: 30 },
    baseSalary: { type: Number, default: 0 },
    // Ingresos
    overtime: { type: Number, default: 0 },
    bonuses: { type: Number, default: 0 },
    commissions: { type: Number, default: 0 },
    decimoTercero: { type: Number, default: 0 }, // mensualizado
    decimoCuarto: { type: Number, default: 0 },
    fondosReserva: { type: Number, default: 0 },
    vacaciones: { type: Number, default: 0 },
    otherIncome: { type: Number, default: 0 },
    totalIngresos: { type: Number, default: 0 },
    // Egresos
    iessPersonal: { type: Number, default: 0 }, // 9.45%
    impuestoRenta: { type: Number, default: 0 },
    prestamoIess: { type: Number, default: 0 },
    prestamoEmpresa: { type: Number, default: 0 },
    anticipos: { type: Number, default: 0 },
    multas: { type: Number, default: 0 },
    otherDeductions: { type: Number, default: 0 },
    totalEgresos: { type: Number, default: 0 },
    netoPagar: { type: Number, default: 0 },
    // Provisiones patronales
    iessPatronal: { type: Number, default: 0 }, // 11.15%
    iece: { type: Number, default: 0 }, // 0.5%
    secap: { type: Number, default: 0 }, // 0.5%
    provDecimoTercero: { type: Number, default: 0 },
    provDecimoCuarto: { type: Number, default: 0 },
    provVacaciones: { type: Number, default: 0 },
    provFondosReserva: { type: Number, default: 0 },
    totalProvisiones: { type: Number, default: 0 },
    notes: String,
  },
  { _id: false }
);

const payrollSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: String,
    year: { type: Number, required: true },
    month: { type: Number, required: true, min: 1, max: 12 },
    period: String, // YYYY-MM
    description: String,
    items: { type: [payrollItemSchema], default: [] },
    totalIngresos: { type: Number, default: 0 },
    totalEgresos: { type: Number, default: 0 },
    totalNeto: { type: Number, default: 0 },
    totalProvisiones: { type: Number, default: 0 },
    status: { type: String, enum: ['BORRADOR', 'CERRADO', 'PAGADO', 'ANULADO'], default: 'BORRADOR' },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' },
    closedAt: Date,
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

payrollSchema.index({ clinic: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Payroll', payrollSchema);
