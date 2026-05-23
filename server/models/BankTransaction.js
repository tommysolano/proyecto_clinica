const mongoose = require('mongoose');

/**
 * Transacción bancaria. Cubre todos los movimientos manuales y los enlaces
 * a otros documentos (cobros, pagos, transferencias, cheques, anticipos, caja chica).
 */
const bankTransactionSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true, index: true },
    date: { type: Date, required: true, index: true },
    type: {
      type: String,
      enum: ['DEPOSITO', 'RETIRO', 'TRANSFERENCIA_IN', 'TRANSFERENCIA_OUT',
             'ANTICIPO', 'CAJA_CHICA', 'CHEQUE_EMITIDO', 'COMISION',
             'INTERES', 'COBRO', 'PAGO', 'AJUSTE'],
      required: true,
    },
    // Cuenta destino para transferencias
    counterpartAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    amount: { type: Number, required: true },
    // signo en libro: +1 entrada, -1 salida
    direction: { type: Number, enum: [1, -1], required: true },
    description: { type: String, default: '' },
    reference: { type: String, default: '' }, // nº papeleta, nº cheque, etc.
    // Comprobante del depósito o transferencia (obligatorio en DEPOSITO/TRANSFERENCIA_IN
    // y al pagar a proveedores desde cuenta bancaria). Puede ser una URL al archivo
    // subido o una referencia/secuencial entregado por el banco.
    voucherUrl: { type: String, default: '' },
    voucherNumber: { type: String, default: '' },
    checkNumber: { type: String, default: null },
    voided: { type: Boolean, default: false },
    voidReason: { type: String, default: '' },
    voidedAt: { type: Date, default: null },
    voidedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    reconciled: { type: Boolean, default: false },
    reconciliation: { type: mongoose.Schema.Types.ObjectId, ref: 'Reconciliation', default: null },
    sourceModel: { type: String, default: null },
    sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('BankTransaction', bankTransactionSchema);
