const mongoose = require('mongoose');

const warehouseSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    address: { type: String, default: '' },
    responsible: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    chartAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    isMain: { type: Boolean, default: false },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

warehouseSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('Warehouse', warehouseSchema);
