const mongoose = require('mongoose');

const voucherSchema = new mongoose.Schema(
  {
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
    invoice: { type: mongoose.Schema.Types.ObjectId, ref: 'Invoice' },
    voucherNumber: String,
    lote: String,
    cardLast4: String,
    cardType: String, // VISA, MASTERCARD, AMEX, DINERS
    grossAmount: { type: Number, default: 0 },
    date: Date,
  },
  { _id: false }
);

const creditCardBatchSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true },
    closeDate: { type: Date, required: true },
    cardType: String,
    acquirer: String, // banco adquiriente (Datafast, Medianet, Pacificard...)
    vouchers: { type: [voucherSchema], default: [] },
    grossAmount: { type: Number, default: 0 },
    commissionRate: { type: Number, default: 0 }, // %
    commissionAmount: { type: Number, default: 0 },
    // % de IVA de la comisión. Antes estaba fijo en 15 dentro del controlador, así que el
    // campo del formulario no hacía nada; ahora es el que manda (15 por defecto).
    ivaCommissionRate: { type: Number, default: 15 },
    ivaCommissionAmount: { type: Number, default: 0 },
    retentionRate: { type: Number, default: 0 },
    retentionAmount: { type: Number, default: 0 },
    netAmount: { type: Number, default: 0 },
    status: { type: String, enum: ['ABIERTO', 'LIQUIDADO', 'ANULADO'], default: 'ABIERTO' },
    liquidationDate: Date,
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount' },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' },
    bankTransaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction' },
    notes: String,
    // Idempotencia de la creación (mismo contrato que los pagos): un doble clic no crea dos lotes.
    idempotencyKey: { type: String, trim: true, default: null },
    idempotencyFingerprint: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

creditCardBatchSchema.index({ clinic: 1, code: 1 }, { unique: true });
creditCardBatchSchema.index(
  { clinic: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } }
);

module.exports = mongoose.model('CreditCardBatch', creditCardBatchSchema);
