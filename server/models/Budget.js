const mongoose = require('mongoose');

const budgetLineSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    // 12 montos mensuales presupuestados (índice 0 = enero)
    amounts: { type: [Number], default: () => Array(12).fill(0) },
  },
  { _id: false }
);

/** Presupuesto anual por cuenta y centro de costo opcional. */
const budgetSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    year: { type: Number, required: true },
    name: { type: String, default: '' },
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    lines: { type: [budgetLineSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

budgetSchema.index({ clinic: 1, year: 1, costCenter: 1 }, { unique: true });

module.exports = mongoose.model('Budget', budgetSchema);
