const mongoose = require('mongoose');

const applicationSchema = new mongoose.Schema(
  {
    docModel: { type: String, enum: ['Invoice', 'PurchaseInvoice'], required: true },
    docRef: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'applications.docModel' },
    docNumber: String,
    amount: { type: Number, required: true, min: 0 },
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
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

paymentSchema.index({ clinic: 1, number: 1 }, { unique: true });

module.exports = mongoose.model('Payment', paymentSchema);
