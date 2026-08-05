const mongoose = require('mongoose');
const { LOAN_TYPES, DISBURSEMENT_METHODS } = require('../services/employeeLoanTypes');

const installmentSchema = new mongoose.Schema(
  {
    number: Number,
    dueDate: Date,
    amount: Number,
    paid: { type: Boolean, default: false },
    paidIn: String, // YYYY-MM (período de rol que descontó)
    paidAt: Date,
  },
  { _id: false }
);

/**
 * PRÉSTAMO O DESCUENTO A UN EMPLEADO, a recuperar por el rol de pagos.
 *
 * Cubre lo que la empresa entrega (préstamo, anticipo, seguro pagado por ella) y lo que solo
 * se descuenta (multa, descuento, impuesto a la renta, cuotas del IESS). Ver
 * `services/employeeLoanTypes` para la cuenta y el concepto de rol de cada tipo.
 *
 * Al crearlo se contabiliza: DEBE la cuenta por cobrar/descontar del tipo, HABER el origen del
 * dinero (banco, caja, caja chica) o la contrapartida que indique el contador. Antes no se
 * generaba NINGÚN asiento —el préstamo era solo una anotación— y la pantalla decía, con razón,
 * que el documento no tenía asiento asociado.
 */
const employeeLoanSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    employee: { type: mongoose.Schema.Types.ObjectId, ref: 'Employee', required: true },
    code: String,
    type: { type: String, enum: Object.keys(LOAN_TYPES), default: 'EMPRESA' },
    grantDate: { type: Date, default: Date.now },
    principal: { type: Number, required: true },
    installmentsCount: { type: Number, required: true },
    installmentAmount: Number,
    interestRate: { type: Number, default: 0 },
    description: String,
    installments: { type: [installmentSchema], default: [] },
    paidAmount: { type: Number, default: 0 },
    balance: { type: Number, default: 0 },

    // ── Asiento del otorgamiento ──────────────────────────────────────────────────────
    // DEBE: lo que el empleado queda debiendo (o el descuento a aplicar). Snapshot: si mañana
    // cambia la configuración de nómina, la recuperación en el rol sigue acreditando ESTA
    // cuenta, la misma que se debitó. Sin el snapshot el par no cerraría.
    receivableAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // HABER cuando NO hay desembolso (multa, descuento, IR…): la contrapartida la elige el contador.
    counterAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    disbursementMethod: { type: String, enum: DISBURSEMENT_METHODS, default: 'SIN_DESEMBOLSO' },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    checkNumber: { type: String, default: '' },
    reference: { type: String, default: '' },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    bankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },

    status: { type: String, enum: ['ACTIVO', 'CANCELADO', 'ANULADO'], default: 'ACTIVO' },
    voidReason: { type: String, default: '' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmployeeLoan', employeeLoanSchema);
