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
    // Elegibilidad de fondos de reserva (snapshot al generar; ≥1 año o activado).
    eligibleFondos: { type: Boolean, default: false },
    // Prorrateo de fondos de reserva (0..1): <1 si el aniversario del año cae dentro del período.
    fondosReservaFactor: { type: Number, default: 1 },
    monthlySalary: { type: Number, default: 0 }, // sueldo contractual completo (para prorrateo)
    baseSalary: { type: Number, default: 0 },    // sueldo GANADO del período (tras ausencias)
    // Anticipo de la 1ª quincena ya PAGADO (activo/CxC al empleado). En el rol de quincena es
    // el único importe; en el cierre de mes se descuenta del neto y se acredita para saldar el
    // anticipo. Es distinto de `anticipos` (deducciones tipo ANTICIPO del catálogo).
    anticipoQuincena: { type: Number, default: 0 },
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
    // Ingresos fijos recurrentes del empleado (snapshot al generar). Se suman al ingreso; gravan
    // IESS solo si `aportaIess`. La cuenta sale de `account` o de la cuenta de sueldos del depto.
    fixedIncomes: {
      type: [new mongoose.Schema({
        concepto: { type: String, default: '' },
        monto: { type: Number, default: 0 },
        aportaIess: { type: Boolean, default: false },
        account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
      }, { _id: false })],
      default: [],
    },
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

// Pago (total o parcial) del rol. Un rol puede liquidarse en varios pagos: cada uno
// aplica contra la obligación (CxP) y afecta Banco/Caja con su propio asiento.
//
// `idempotencyKey` identifica la INTENCIÓN de pago (el cliente la genera por intención, no
// por reintento): un doble clic o un reintento de red con la misma clave devuelve el pago ya
// registrado en vez de duplicar banco y aplicación. `fingerprint` es la huella del contenido
// de esa solicitud: si llega la misma clave con otro importe/banco/fecha, se responde 409.
const payrollPaymentSchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    bankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
    reference: { type: String, default: '' },
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    idempotencyKey: { type: String, trim: true, default: null },
    fingerprint: { type: String, default: null },
  },
  { _id: false }
);

const payrollSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: String,
    year: { type: Number, required: true, min: 2000, max: 2100 },
    month: { type: Number, required: true, min: 1, max: 12 },
    // Tipo de período. MENSUAL = rol mensual completo (default histórico). Nómina quincenal:
    // QUINCENA_1 = anticipo de la 1ª quincena (solo sueldo, sin IESS ni beneficios);
    // CIERRE_MES = liquidación del mes completo descontando el anticipo ya pagado.
    periodType: { type: String, enum: ['MENSUAL', 'QUINCENA_1', 'CIERRE_MES'], default: 'MENSUAL' },
    period: String, // YYYY-MM
    description: String,
    items: { type: [payrollItemSchema], default: [] },
    totalIngresos: { type: Number, default: 0 },
    totalEgresos: { type: Number, default: 0 },
    totalNeto: { type: Number, default: 0 },
    totalProvisiones: { type: Number, default: 0 },
    status: { type: String, enum: ['BORRADOR', 'CERRADO', 'PAGADO', 'ANULADO'], default: 'BORRADOR' },
    // Fecha CONTABLE del cierre (devengo del gasto). Antes se forzaba el día 28 del mes;
    // ahora la elige el usuario al cerrar (por defecto, el último día del período).
    accountingDate: { type: Date, default: null },
    // Fecha en la que se PLANEA pagar el neto. Alimenta la proyección de flujo de caja
    // (es el vencimiento de la obligación de sueldos por pagar).
    scheduledPaymentDate: { type: Date, default: null },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' },
    // Obligación (CxP) por el neto de sueldos por pagar, abierta al cerrar. El pasivo
    // contable lo reconoce el asiento de cierre: esta CxP es solo el submayor.
    payableRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Payable', default: null },
    closedAt: Date,
    closedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Pagos del rol (total o parciales).
    payments: { type: [payrollPaymentSchema], default: [] },
    // Compat: reflejan el PRIMER pago registrado (los módulos antiguos los leen).
    paymentJournalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    paymentBankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
    paymentBankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    paidAt: Date,
    paidBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

/**
 * Total pagado. La FUENTE DE VERDAD del saldo contable es la CxP (`Payable.applied`):
 * `payments[]` es su espejo, escrito en la MISMA transacción que la aplicación, y no hay
 * ningún endpoint que lo modifique por separado.
 *
 * Estos virtuales son SÍNCRONOS y no pueden leer la cartera, así que son solo una
 * aproximación local. Cuando el rol tiene obligación (`payableRef`), los controladores
 * SOBRESCRIBEN estos valores con el saldo real de la CxP (ver `withObligation` en
 * payrollController): el saldo de la CxP siempre prevalece sobre el estado del rol.
 *
 * Fallback legacy: un rol histórico marcado PAGADO, SIN `payments[]` y SIN `payableRef`
 * (anterior a que existiera la obligación) no tiene de dónde sacar el dato; ahí, y solo
 * ahí, su estado se toma como que el neto está pagado. Si tiene `payableRef`, NO se asume
 * nada: manda la CxP.
 */
payrollSchema.virtual('paidAmount').get(function () {
  const registrados = +(this.payments || []).reduce((s, p) => s + (Number(p.amount) || 0), 0).toFixed(2);
  if (registrados > 0) return registrados;
  const esLegacySinCartera = !this.payableRef && this.status === 'PAGADO';
  return esLegacySinCartera ? +(Number(this.totalNeto) || 0).toFixed(2) : 0;
});
/** Saldo pendiente del neto (lo sobrescribe el saldo de la CxP cuando existe obligación). */
payrollSchema.virtual('pendingAmount').get(function () {
  return +((Number(this.totalNeto) || 0) - this.paidAmount).toFixed(2);
});
payrollSchema.set('toJSON', { virtuals: true });
payrollSchema.set('toObject', { virtuals: true });

// Un rol por (clínica, año, mes, TIPO de período): así conviven la quincena y el cierre del
// mismo mes. Los roles antiguos (sin periodType) migran a 'MENSUAL' (ver scripts/migratePayrollPeriodType.js).
payrollSchema.index({ clinic: 1, year: 1, month: 1, periodType: 1 }, { unique: true });
// Idempotencia de pagos: una clave no puede reutilizarse en otro rol de la misma clínica.
// (Dentro de un mismo rol la protección es el chequeo transaccional de markPaid, que se
// serializa por conflicto de escritura sobre este documento.) Parcial: los pagos legacy
// sin clave no colisionan entre sí.
payrollSchema.index(
  { clinic: 1, 'payments.idempotencyKey': 1 },
  { unique: true, partialFilterExpression: { 'payments.idempotencyKey': { $type: 'string' } } }
);

module.exports = mongoose.model('Payroll', payrollSchema);
