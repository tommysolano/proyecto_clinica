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
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

creditCardBatchSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('CreditCardBatch', creditCardBatchSchema);
