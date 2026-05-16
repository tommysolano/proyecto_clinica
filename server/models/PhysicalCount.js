const mongoose = require('mongoose');

const countItemSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true },
    productCode: String,
    productName: String,
    systemQty: { type: Number, default: 0 },
    countedQty: { type: Number, default: 0 },
    difference: { type: Number, default: 0 },
    unitCost: { type: Number, default: 0 },
    adjustmentValue: { type: Number, default: 0 },
    notes: String,
  },
  { _id: false }
);

const physicalCountSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    date: { type: Date, default: Date.now },
    description: String,
    items: { type: [countItemSchema], default: [] },
    status: { type: String, enum: ['BORRADOR', 'CONFIRMADO', 'ANULADO'], default: 'BORRADOR' },
    adjustmentEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    confirmedAt: Date,
    confirmedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

physicalCountSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('PhysicalCount', physicalCountSchema);
