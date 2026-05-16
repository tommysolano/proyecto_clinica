const mongoose = require('mongoose');

const bankAccountSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    bank: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    accountType: { type: String, enum: ['CORRIENTE', 'AHORROS', 'VIRTUAL'], default: 'CORRIENTE' },
    currency: { type: String, default: 'USD' },
    city: { type: String, default: '' },
    chartAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    // Saldo de control (libro). Se actualiza desde transacciones.
    bookBalance: { type: Number, default: 0 },
    initialBalance: { type: Number, default: 0 },
    initialBalanceDate: { type: Date, default: null },
    // Cheques
    nextCheckNumber: { type: Number, default: 1 },
    checkFormat: { type: String, default: '' },
    active: { type: Boolean, default: true },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

bankAccountSchema.index({ clinic: 1, accountNumber: 1 }, { unique: true });

module.exports = mongoose.model('BankAccount', bankAccountSchema);
