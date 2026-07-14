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
    // IDENTIDAD del activo dentro de la compra: línea y unidad. Una línea de 3 monitores son
    // TRES activos (unidades 0,1,2), cada uno con su costo unitario, y volver a contabilizar la
    // compra reconoce a cada uno por su identidad en vez de borrarlos y recrearlos (que es como
    // se duplicaban los que ya tenían depreciación). `purchaseItemSchema` es `_id:false`, así
    // que la identidad de la línea es su ÍNDICE.
    purchaseLineIndex: { type: Number, default: null },
    purchaseUnitIndex: { type: Number, default: null },
    // Identidad ESTABLE de la línea (`PurchaseInvoice.items[].lineId`). Manda sobre el índice
    // posicional: si se borra o reordena una línea, el activo sigue reconociendo LA SUYA.
    purchaseLineId: { type: String, default: null },
    // Proveedor y centro de costo de la compra (el activo los conserva aunque la compra cambie).
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', default: null },
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    // Bodega/ubicación física cuando la línea de compra la declara.
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    // Asiento contable de compra/alta que originó el activo (navegación mayor ↔ activo).
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    acquisitionDate: { type: Date, required: true },
    acquisitionCost: { type: Number, required: true },
    residualValue: { type: Number, default: 0 },
    residualPercent: { type: Number, default: 0 }, // % usado para calcular residual
    depreciationRate: { type: Number, required: true },
    usefulLifeMonths: { type: Number, required: true },
    // Snapshot del tipo de gasto (ADMINISTRATIVO/VENTAS/COSTOS/OTRO) copiado de la
    // categoría al crear el activo (historial: si la categoría cambia, el activo conserva).
    expenseType: { type: String, default: '' },
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

// Un activo por (clínica, compra, línea, unidad): dos contabilizaciones de la misma compra no
// pueden crear dos activos para la misma unidad, ni siquiera en carrera. Parcial porque los
// activos creados a mano (sin compra) no tienen esta identidad.
fixedAssetSchema.index(
  {
    clinic: 1, purchaseInvoice: 1, purchaseLineIndex: 1, purchaseUnitIndex: 1,
  },
  {
    unique: true,
    partialFilterExpression: {
      purchaseInvoice: { $type: 'objectId' },
      purchaseLineIndex: { $type: 'number' },
      purchaseUnitIndex: { $type: 'number' },
    },
  }
);

module.exports = mongoose.model('FixedAsset', fixedAssetSchema);
