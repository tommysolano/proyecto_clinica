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
    /**
     * PERSONA del movimiento (nombre o razón social): a quién se le pagó o de quién se cobró.
     * Es una copia, no una referencia: el banco quiere saber a nombre de quién salió el dinero
     * ese día, aunque después se corrija la ficha del proveedor. El contador busca por aquí.
     * Vacío en los movimientos que no tienen contraparte (una comisión bancaria, un ajuste).
     */
    partyName: { type: String, default: '', trim: true },
    /**
     * Centro de costo del movimiento (sucursal / área a la que se carga). Se copia al asiento.
     * Los movimientos anteriores a este campo no lo tienen: filtrar por centro no los devuelve.
     */
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null, index: true },
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

// Mantener el bookBalance de la cuenta al crear una transacción nueva (no anulada).
bankTransactionSchema.pre('save', function (next) {
  this.$locals.wasNew = this.isNew;
  next();
});

bankTransactionSchema.post('save', async function (doc) {
  try {
    if (doc.$locals.wasNew && !doc.voided) {
      const BankAccount = mongoose.model('BankAccount');
      const session = doc.$session?.();
      await BankAccount.updateOne(
        { _id: doc.bankAccount },
        { $inc: { bookBalance: doc.amount * doc.direction } }
      ).session(session || null);
    }
  } catch (e) { /* el saldo agregado (endpoint balances) sigue siendo la fuente de verdad */ }
});

module.exports = mongoose.model('BankTransaction', bankTransactionSchema);
