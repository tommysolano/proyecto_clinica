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
    // Tipo de activo: subcategoría (InventoryCategory con parent = category)
    assetType: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    serial: String,
    location: String, // ubicación específica (área/consultorio) en texto libre
    // Sede/clínica donde está físicamente el activo
    locationClinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    responsible: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Cuentas contables ligadas al activo (si no se setean, se usan las de la categoría)
    assetAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    depreciationAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    accumDepreciationAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Factura de compra de la que proviene el activo
    purchaseInvoice: { type: mongoose.Schema.Types.ObjectId, ref: 'PurchaseInvoice', default: null },
    acquisitionDate: { type: Date, required: true },
    acquisitionCost: { type: Number, required: true },
    residualValue: { type: Number, default: 0 },
    residualPercent: { type: Number, default: 0 }, // % usado para calcular residual
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
