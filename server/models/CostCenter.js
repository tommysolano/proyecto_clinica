const mongoose = require('mongoose');

const costCenterSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true, trim: true },
    name: { type: String, required: true, trim: true },
    parent: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    description: { type: String, default: '' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

costCenterSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('CostCenter', costCenterSchema);
