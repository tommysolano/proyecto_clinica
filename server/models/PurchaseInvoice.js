const mongoose = require('mongoose');

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
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', default: null },
    warehouse: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', default: null },
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
    ice: { type: Number, default: 0 },
    propina: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    retentions: { type: [retentionItemSchema], default: [] },
    retentionTotal: { type: Number, default: 0 },
    retentionNumber: String, // nº comprobante retención emitida
    balance: { type: Number, default: 0 }, // saldo por pagar
    paid: { type: Boolean, default: false },
    status: { type: String, enum: ['REGISTRADA', 'PAGADA', 'ANULADA'], default: 'REGISTRADA' },
    paymentMethodSri: { type: String, default: '' },
    notes: { type: String, default: '' },
    deductible: { type: Boolean, default: true },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    retentionJournalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    importedFromTxt: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

purchaseInvoiceSchema.index({ clinic: 1, supplier: 1, serie: 1 }, { unique: true, partialFilterExpression: { serie: { $type: 'string' } } });

module.exports = mongoose.model('PurchaseInvoice', purchaseInvoiceSchema);
