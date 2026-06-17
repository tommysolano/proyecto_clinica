const mongoose = require('mongoose');

/**
 * Movimiento de caja dentro de una sesión abierta (CashClosing): ingresos
 * varios, egresos/gastos de caja chica, retiros y depósitos a banco. Cada uno
 * genera su asiento contra la cuenta de Caja.
 */
const cashMovementSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    cashSession: { type: mongoose.Schema.Types.ObjectId, ref: 'CashClosing', required: true, index: true },
    date: { type: Date, required: true, default: Date.now },
    type: {
      type: String,
      enum: ['INGRESO', 'EGRESO', 'GASTO', 'RETIRO', 'DEPOSITO'],
      required: true,
    },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, default: '' },
    // Cuenta contraparte (gasto para GASTO/EGRESO, ingreso para INGRESO, etc.).
    counterpartAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Cuenta bancaria destino para DEPOSITO / RETIRO a banco.
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    bankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
    voided: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

cashMovementSchema.index({ clinic: 1, cashSession: 1, voided: 1 });

// Signo del movimiento sobre el efectivo en caja: +1 ingresa, -1 sale.
cashMovementSchema.virtual('cashSign').get(function () {
  return this.type === 'INGRESO' ? 1 : -1;
});

module.exports = mongoose.model('CashMovement', cashMovementSchema);
