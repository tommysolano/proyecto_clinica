const mongoose = require('mongoose');

// Distribución de un ítem de compra en varias cuentas contables.
const accountSplitSchema = new mongoose.Schema(
  {
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', required: true },
    amount: { type: Number, default: 0 },
    description: { type: String, default: '' },
  },
  { _id: false }
);

// Datos del activo fijo capturados en la línea de compra cuando lineType = ACTIVO_FIJO.
// Reflejan el modal "Nuevo activo fijo"; al contabilizar se crea el FixedAsset.
const fixedAssetCaptureSchema = new mongoose.Schema(
  {
    category: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    assetType: { type: mongoose.Schema.Types.ObjectId, ref: 'InventoryCategory', default: null },
    code: { type: String, default: '' },
    name: { type: String, default: '' },
    serial: { type: String, default: '' },
    location: { type: String, default: '' },
    locationClinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', default: null },
    responsible: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    acquisitionDate: { type: Date, default: null },
    startDate: { type: Date, default: null },
    depreciationRate: { type: Number, default: 0 },
    usefulLifeMonths: { type: Number, default: 0 },
    residualPercent: { type: Number, default: 0 },
    assetAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    depreciationAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    accumDepreciationAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount', default: null },
    // Referencia al FixedAsset creado (idempotencia al re-contabilizar/editar).
    createdAsset: { type: mongoose.Schema.Types.ObjectId, ref: 'FixedAsset', default: null },
  },
  { _id: false }
);

const purchaseItemSchema = new mongoose.Schema(
  {
    description: { type: String, required: true },
    quantity: { type: Number, default: 1, min: 0 },
    unitPrice: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    subtotal: { type: Number, required: true },
    ivaRate: { type: Number, default: 15 },
    ivaAmount: { type: Number, default: 0 },
    account: { type: mongoose.Schema.Types.ObjectId, ref: 'ChartOfAccount' },
    // Permite distribuir el ítem en varias cuentas contables. Si tiene elementos,
    // se usa en lugar de `account` y la suma de los montos debe igualar el subtotal.
    accountSplits: { type: [accountSplitSchema], default: [] },
    // Clasificación de la línea: GASTO (cuenta de gasto), INVENTARIO (cuenta de activo
    // + producto que sube stock) o ACTIVO_FIJO (crea un activo fijo al contabilizar).
    lineType: { type: String, enum: ['GASTO', 'INVENTARIO', 'ACTIVO_FIJO'], default: 'GASTO' },
    // Centro de costo de la línea (opcional). Se propaga al asiento contable.
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    fixedAsset: { type: fixedAssetCaptureSchema, default: null },
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
    // Lote y caducidad opcionales para insumos/medicamentos (kardex FIFO por capas).
    lot: { type: String, default: '' },
    expiryDate: { type: Date, default: null },
  },
  { _id: false }
);

const retentionItemSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['IVA', 'RENTA'], required: true },
    code: String,        // 303, 312, etc.
    description: String,
    baseAmount: Number,
    percentage: Number,
    amount: Number,
  },
  { _id: false }
);

/**
 * Factura recibida de un proveedor (compra).
 */
const purchaseInvoiceSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true },
    docType: { type: String, enum: ['FACTURA', 'NOTA_VENTA', 'LIQUIDACION', 'NOTA_DEBITO_REC', 'NOTA_CREDITO_REC'], default: 'FACTURA' },
    estab: String,
    ptoEmi: String,
    secuencial: String,
    serie: { type: String }, // 001-001-000000001
    claveAcceso: { type: String, index: true },
    fechaEmision: { type: Date, required: true },
    fechaRegistro: { type: Date, default: Date.now },
    fechaVencimiento: { type: Date, default: null },
    // Días de crédito acordados (para informar/recalcular el vencimiento).
    creditDays: { type: Number, default: 0 },
    // Centro de costo por defecto de la factura (se copia a las líneas sin centro).
    costCenter: { type: mongoose.Schema.Types.ObjectId, ref: 'CostCenter', default: null },
    autorizacion: { type: String, default: '' },
    items: { type: [purchaseItemSchema], default: [] },
    subtotal0: { type: Number, default: 0 },
    subtotal12: { type: Number, default: 0 },
    subtotal15: { type: Number, default: 0 },
    subtotalNoObjeto: { type: Number, default: 0 },
    subtotalExento: { type: Number, default: 0 },
    subtotal: { type: Number, default: 0 },
    discount: { type: Number, default: 0 },
    iva: { type: Number, default: 0 },
    // Desglose del IVA en compras: con derecho a crédito tributario vs no recuperable (al gasto)
    vatCreditAmount: { type: Number, default: 0 },
    vatNonCreditAmount: { type: Number, default: 0 },
    ice: { type: Number, default: 0 },
    propina: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    retentions: { type: [retentionItemSchema], default: [] },
    retentionTotal: { type: Number, default: 0 },
    retentionNumber: String, // nº comprobante retención emitida
    retentionVoucher: { type: mongoose.Schema.Types.ObjectId, ref: 'RetentionVoucher', default: null },
    balance: { type: Number, default: 0 }, // saldo por pagar
    paid: { type: Boolean, default: false },
    status: { type: String, enum: ['POR_AUTORIZAR', 'REGISTRADA', 'PAGADA', 'ANULADA'], default: 'REGISTRADA' },
    paymentMethodSri: { type: String, default: '' },
    notes: { type: String, default: '' },
    deductible: { type: Boolean, default: true },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    retentionJournalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    importedFromTxt: { type: Boolean, default: false },
    importedFromXml: { type: Boolean, default: false },
    // Datos crudos del XML del SRI para auditoría/verificación
    xmlClaveAcceso: { type: String, default: '' },
    authorizedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    authorizedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

purchaseInvoiceSchema.index({ clinic: 1, supplier: 1, serie: 1 }, { unique: true, partialFilterExpression: { serie: { $type: 'string' } } });

module.exports = mongoose.model('PurchaseInvoice', purchaseInvoiceSchema);
