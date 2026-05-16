const mongoose = require('mongoose');

const reconciliationItemSchema = new mongoose.Schema(
  {
    transaction: { type: mongoose.Schema.Types.ObjectId, ref: 'BankTransaction', required: true },
    matched: { type: Boolean, default: false },
    statementRef: { type: String, default: '' },
  },
  { _id: false }
);

const reconciliationSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    bankAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'BankAccount', required: true, index: true },
    periodStart: { type: Date, required: true },
    periodEnd: { type: Date, required: true },
    statementBalance: { type: Number, required: true },
    bookBalance: { type: Number, default: 0 },
    difference: { type: Number, default: 0 },
    items: { type: [reconciliationItemSchema], default: [] },
    status: { type: String, enum: ['BORRADOR', 'CONCILIADO'], default: 'BORRADOR' },
    notes: { type: String, default: '' },
    closedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Reconciliation', reconciliationSchema);
