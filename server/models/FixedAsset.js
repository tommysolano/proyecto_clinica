const mongoose = require('mongoose');

const depreciationRecordSchema = new mongoose.Schema(
  {
    period: String, // YYYY-MM
    date: Date,
    amount: Number,
    accumulated: Number,
    bookValue: Number,
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry' },
  },
  { _id: false }
);

const fixedAssetSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    code: { type: String, required: true },
    name: { type: String, required: true },
    description: String,
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory' },
    serial: String,
    location: String,
    responsible: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    acquisitionDate: { type: Date, required: true },
    acquisitionCost: { type: Number, required: true },
    residualValue: { type: Number, default: 0 },
    depreciationRate: { type: Number, required: true },
    usefulLifeMonths: { type: Number, required: true },
    startDate: { type: Date, required: true }, // inicio depreciación
    accumulatedDepreciation: { type: Number, default: 0 },
    bookValue: { type: Number, default: 0 },
    monthlyDepreciation: { type: Number, default: 0 },
    lastDepreciationPeriod: { type: String, default: '' }, // YYYY-MM
    status: { type: String, enum: ['ACTIVO', 'DADO_DE_BAJA', 'VENDIDO'], default: 'ACTIVO' },
    disposalDate: Date,
    disposalValue: Number,
    history: { type: [depreciationRecordSchema], default: [] },
    notes: String,
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

fixedAssetSchema.index({ clinic: 1, code: 1 }, { unique: true });

module.exports = mongoose.model('FixedAsset', fixedAssetSchema);
