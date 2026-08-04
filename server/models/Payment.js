const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema(
  {
    docModel: { type: String, enum: ['Invoice', 'PurchaseInvoice', 'Sale'], required: true },
    docRef: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'applications.docModel' },
    docNumber: String,
    amount: { type: Number, required: true, min: 0 },
    // Cartera sobre la que se aplicó REALMENTE el importe. Una venta y su factura son la misma
    // obligación económica: cobrar la factura reduce la cartera del documento canónico (que
    // puede ser la venta). Anular tiene que devolver el saldo a ESA misma cartera, no a la que
    // diga el documento: si no, la reversión iría a otro submayor y el par quedaría irresoluble.
    // Vacío en los cobros/pagos antiguos: entonces se aplica sobre el propio documento.
    appliedTo: {
      sourceModel: { type: String, enum: ['Invoice', 'PurchaseInvoice', 'Sale', null], default: null },
      sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    },
  },
  { _id: false }
);

const paymentSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    type: { type: String, enum: ['COBRO', 'PAGO'], required: true },
    number: { type: String, required: true },
    date: { type: Date, required: true, index: true },
    // Tercero involucrado
    partyModel: { type: String, enum: ['Patient', 'Supplier', 'User'], required: true },
    partyRef: { type: mongoose.Schema.Types.ObjectId, refPath: 'partyModel' },
    partyName: { type: String, default: '' },
    partyId: { type: String, default: '' }, // cédula/ruc
    method: {
      type: String,
      enum: ['EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'TARJETA', 'DEPOSITO', 'OTRO'],
      required: true,
    },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', default: null },
    checkNumber: String,
    cardBatch: { type: mongoose.Schema.Types.ObjectId, ref: 'CreditCardBatch', default: null },
    reference: { type: String, default: '' },
    total: { type: Number, required: true },
    applications: { type: [applicationSchema], default: [] },
    appliedAmount: { type: Number, default: 0 },
    advanceAmount: { type: Number, default: 0 }, // anticipo (sin aplicar)
    description: { type: String, default: '' },
    status: { type: String, enum: ['REGISTRADO', 'ANULADO'], default: 'REGISTRADO' },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    bankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', default: null },
    // Depósito que se llevó al banco el efectivo de este cobro (solo cobros EN EFECTIVO).
    cashDeposit: { type: mongoose.Schema.Types.ObjectId, ref: 'CashDeposit', default: null },
    // Clave de idempotencia (opcional): la envía el cliente por body o header
    // `Idempotency-Key`. Evita que un doble clic / reintento de red registre el mismo
    // cobro o pago dos veces. Ver el índice único parcial de abajo.
    idempotencyKey: { type: String, trim: true, default: null },
    // Huella del contenido de la solicitud que creó el pago. Si llega la MISMA clave con
    // otro contenido (importe, método, banco, documentos aplicados…) se responde 409 en vez
    // de devolver por error un pago que no corresponde a lo pedido. Los pagos anteriores a
    // este campo no la tienen: ahí se conserva el comportamiento previo (replay).
    idempotencyFingerprint: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

paymentSchema.index({ clinic: 1, number: 1 }, { unique: true });
// Único por clínica SOLO cuando hay clave: dos pagos sin clave (legacy) no colisionan.
paymentSchema.index(
  { clinic: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('Payment', paymentSchema);
