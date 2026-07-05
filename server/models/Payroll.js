const mongoose = require('mongoose');

// Rubro flexible del rol (ingreso/egreso agregado por el usuario). La cuenta NO
// se captura aquí: se resuelve desde el PayrollConcept al cerrar. Guarda snapshot
// de código/nombre/monto para auditoría.
const payrollLineSchema = new mongoose.Schema(
  {
    concept: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollConcept', default: null },
    code: { type: String, default: '' },
    name: { type: String, default: '' },
    amount: { type: Number, default: 0 },
  },
  { _id: false }
);

const payrollItemSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    employeeName: String,
    identificacion: String,
    // Snapshot del departamento (clasifica el gasto en el P&L y resuelve la cuenta).
    departmentRef: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollDepartment', default: null },
    departmentType: { type: String, default: '' }, // ADMINISTRATIVO/VENTAS/COSTOS/OTRO snapshot
    daysWorked: { type: Number, default: 30 },
    absenceDays: { type: Number, default: 0 }, // faltas injustificadas (reducen el sueldo)
    monthlySalary: { type: Number, default: 0 }, // sueldo contractual completo (para prorrateo)
    baseSalary: { type: Number, default: 0 },    // sueldo GANADO del período (tras ausencias)
    // Ingresos
    overtime: { type: Number, default: 0 },
    bonuses: { type: Number, default: 0 },
    commissions: { type: Number, default: 0 },
    decimoTercero: { type: Number, default: 0 }, // mensualizado
    decimoCuarto: { type: Number, default: 0 },
    fondosReserva: { type: Number, default: 0 },
    vacaciones: { type: Number, default: 0 },
    // Vacaciones GOZADAS pagadas contra la provisión acumulada (debita Vacaciones
    // por pagar en vez de gasto; no se acumula provisión como si no se tomaran).
    vacacionesContraProvision: { type: Number, default: 0 },
    otherIncome: { type: Number, default: 0 },
    // Rubros flexibles agregados por el usuario (cuenta desde el concepto).
    earnings: { type: [payrollLineSchema], default: [] },
    deductions: { type: [payrollLineSchema], default: [] },
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
    // Pago del rol (desde banco o caja): asiento y transacción bancaria.
    paymentJournalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    paymentBankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
    paymentBankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    paidAt: Date,
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

payrollSchema.index({ clinic: 1, year: 1, month: 1 }, { unique: true });

module.exports = mongoose.model('Payroll', payrollSchema);
