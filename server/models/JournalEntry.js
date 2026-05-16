const mongoose = require('mongoose');

const journalLineSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    accountCode: String,
    accountName: String,
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    description: { type: String, default: '' },
    debit: { type: Number, default: 0, min: 0 },
    credit: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/**
 * Asiento contable con partida doble.
 * source: VENTA | COMPRA | COBRO | PAGO | NOMINA | DEPRECIACION | AJUSTE | APERTURA | CIERRE | MANUAL | BANCO | NC | ND
 */
const journalEntrySchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    number: { type: String, required: true },
    date: { type: Date, required: true, index: true },
    period: { type: mongoose.Schema.Types.ObjectId, ref: 'FiscalPeriod' },
    description: { type: String, default: '' },
    source: {
      type: String,
      enum: [
        'VENTA', 'COMPRA', 'COBRO', 'PAGO', 'NOMINA',
        'DEPRECIACION', 'AJUSTE', 'APERTURA', 'CIERRE',
        'MANUAL', 'BANCO', 'NC', 'ND', 'CHEQUE', 'TARJETA',
      ],
      default: 'MANUAL',
    },
    sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    sourceModel: { type: String, default: null },
    lines: { type: [journalLineSchema], default: [] },
    totalDebit: { type: Number, default: 0 },
    totalCredit: { type: Number, default: 0 },
    status: { type: String, enum: ['BORRADOR', 'CONTABILIZADO', 'ANULADO'], default: 'CONTABILIZADO' },
    reversedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    reverses: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

journalEntrySchema.index({ clinic: 1, number: 1 }, { unique: true });

journalEntrySchema.pre('validate', function (next) {
  this.totalDebit = (this.lines || []).reduce((s, l) => s + (l.debit || 0), 0);
  this.totalCredit = (this.lines || []).reduce((s, l) => s + (l.credit || 0), 0);
  next();
});

module.exports = mongoose.model('JournalEntry', journalEntrySchema);
