const mongoose = require('mongoose');

const employeeSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true },
    identificacion: { type: String, required: true },
    tipoIdentificacion: { type: String, enum: ['CEDULA', 'RUC', 'PASAPORTE'], default: 'CEDULA' },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    email: String,
    phone: String,
    address: String,
    birthDate: Date,
    hireDate: { type: Date, required: true },
    exitDate: Date,
    // Cargo/departamento LEGACY como texto libre (se conservan por compatibilidad).
    position: String,
    department: String,
    // Cargo/departamento PARAMETRIZADO (catálogo). Para efectos contables se usan
    // estas referencias; los strings de arriba quedan solo como respaldo legacy.
    departmentRef: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollDepartment', default: null },
    positionRef: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollPosition', default: null },
    // Forma de pago del sueldo y banco del sistema desde el que se paga (opcional).
    paymentMethod: { type: String, enum: ['TRANSFERENCIA', 'CHEQUE', 'EFECTIVO'], default: 'TRANSFERENCIA' },
    paymentBankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    contractType: { type: String, enum: ['INDEFINIDO', 'FIJO', 'EVENTUAL', 'PRACTICAS', 'TIEMPO_PARCIAL'], default: 'INDEFINIDO' },
    paymentFrequency: { type: String, enum: ['MENSUAL', 'QUINCENAL', 'SEMANAL'], default: 'MENSUAL' },
    // Anticipo de la 1ª quincena: % del sueldo. null = usa el de PayrollConfig.
    anticipoQuincenaPct: { type: Number, default: null, min: 0, max: 100 },
    // Ingresos fijos recurrentes (ej. "Alimentación $50/mes"). Se suman en el rol MENSUAL/CIERRE
    // (en quincena solo si includeInQuincena). Afectan la base de IESS solo si aportaIess.
    fixedIncomes: {
      type: [new mongoose.Schema({
        concepto: { type: String, required: true, trim: true },
        monto: { type: Number, required: true, min: 0 },
        aportaIess: { type: Boolean, default: false },
        includeInQuincena: { type: Boolean, default: false },
        // Concepto del catálogo: su cuenta se resuelve POR DEPARTAMENTO del empleado (con
        // herencia a la cuenta general del concepto). Es la fuente preferida de la cuenta.
        concept: { type: mongoose.Schema.Types.ObjectId, ref: 'PayrollConcept', default: null },
        // Cuenta contable directa (opcional, legacy): solo se usa si no hay `concept`; si tampoco
        // hay cuenta, cae a la cuenta de sueldos del depto.
        account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
        activo: { type: Boolean, default: true },
      }, { _id: true })],
      default: [],
    },
    // Tipo de sueldo pactado en el contrato.
    // - GROSS: baseSalary es el sueldo bruto (ingreso afecto a IESS/IR). Es el caso estándar.
    // - NET: el contrato es por sueldo neto a recibir; baseSalary representa el bruto
    //   calculado (gross-up) para asegurar que netoPagar == netSalary cada mes.
    salaryType: { type: String, enum: ['GROSS', 'NET'], default: 'GROSS' },
    baseSalary: { type: Number, required: true }, // bruto mensual a usar en cálculos
    netSalary: { type: Number, default: 0 },      // neto pactado cuando salaryType === 'NET'
    // Historial de cambios de sueldo (auditoría)
    salaryHistory: {
      type: [{
        date: { type: Date, default: Date.now },
        previousType: { type: String, enum: ['GROSS', 'NET'] },
        previousSalary: Number,
        previousNet: Number,
        newType: { type: String, enum: ['GROSS', 'NET'] },
        newSalary: Number,
        newNet: Number,
        reason: String,
        changedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      }],
      default: [],
    },
    sectoralCode: String, // código comisión sectorial
    bankAccount: String,
    bankName: String,
    bankAccountType: { type: String, enum: ['', 'AHORROS', 'CORRIENTE'], default: '' },
    // De dónde sale el sueldo (sede/clínica que asume el costo) y centro de costo
    salaryOriginClinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    // Si el gasto de sueldo es deducible para impuesto a la renta
    deductible: { type: Boolean, default: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // si tiene login
    // Cargas familiares y beneficios
    chargesFamily: { type: Number, default: 0 },
    receivesUtilities: { type: Boolean, default: true },
    receivesDecimoTercero: { type: Boolean, default: true },
    receivesDecimoCuarto: { type: Boolean, default: true },
    receivesFondosReserva: { type: Boolean, default: false }, // se activa al cumplir 1 año
    // Los fondos de reserva se ganan al cumplir 1 AÑO con el empleador (regla legal EC). El modo
    // (MENSUALIZAR/ACUMULAR) se DECIDE al llegar el aniversario: mientras `fondosReservaModeSet`
    // sea false y el empleado ya cumplió el año, la generación del rol pide la decisión (modal).
    fondosReservaModeSet: { type: Boolean, default: false },
    decimoTerceroAcumulado: { type: String, enum: ['ACUMULADO', 'MENSUALIZADO'], default: 'MENSUALIZADO' },
    decimoCuartoAcumulado: { type: String, enum: ['ACUMULADO', 'MENSUALIZADO'], default: 'MENSUALIZADO' },
    fondosReservaAcumulado: { type: String, enum: ['ACUMULADO', 'MENSUALIZADO'], default: 'MENSUALIZADO' },
    active: { type: Boolean, default: true },
    notes: String,
  },
  { timestamps: true }
);

employeeSchema.index({ clinic: 1, code: 1 }, { unique: true });
employeeSchema.index({ clinic: 1, identificacion: 1 }, { unique: true });

module.exports = mongoose.model('Employee', employeeSchema);
