const mongoose = require('mongoose');

const retentionLineSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['RENTA', 'IVA', 'ISD'], required: true },
    sriTaxCode: { type: String, required: true },
    code: { type: String, required: true },
    description: { type: String, default: '' },
    baseAmount: { type: Number, required: true, min: 0 },
    percentage: { type: Number, required: true, min: 0 },
    amount: { type: Number, required: true, min: 0 },
  },
  { _id: false }
);

const sriMessageSchema = new mongoose.Schema(
  {
    identificador: String,
    mensaje: String,
    informacionAdicional: String,
    tipo: String,
  },
  { _id: false }
);

const retentionVoucherSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    purchaseInvoice: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'PurchaseInvoice',
      required: true,
      index: true,
    },
    supplier: { type: mongoose.Schema.Types.ObjectId, ref: 'Supplier', required: true, index: true },
    supplierName: { type: String, default: '' },
    supplierId: { type: String, default: '' },
    supplierIdType: { type: String, default: '01' },

    estab: { type: String, required: true },
    ptoEmi: { type: String, required: true },
    secuencial: { type: String, required: true },
    serie: { type: String, required: true },
    claveAcceso: { type: String, required: true, index: true },
    ambiente: { type: String, enum: ['1', '2'], default: '1' },
    fechaEmision: { type: Date, required: true, index: true },
    periodoFiscal: { type: String, required: true },

    purchaseDocType: { type: String, default: '01' },
    purchaseSerie: { type: String, default: '' },
    purchaseAuthorization: { type: String, default: '' },
    purchaseIssueDate: { type: Date, default: null },
    purchaseTotal: { type: Number, default: 0 },
    purchaseTaxBase: { type: Number, default: 0 },
    codSustento: { type: String, default: '01' },

    retentions: { type: [retentionLineSchema], default: [] },
    totalRetenido: { type: Number, default: 0 },

    estado: {
      type: String,
      enum: [
        'BORRADOR',
        'EN_COLA',
        'FIRMADO',
        'RECIBIDA',
        'AUTORIZADO',
        'NO_AUTORIZADO',
        'DEVUELTA',
        'ERROR',
        'ANULADA',
        'PENDIENTE_ANULACION',
        'REGISTRADA',
      ],
      default: 'REGISTRADA',
      index: true,
    },
    xml: { type: String, default: '' },
    xmlFirmado: { type: String, default: '' },
    xmlAutorizado: { type: String, default: '' },
    numeroAutorizacion: { type: String, default: '' },
    fechaAutorizacion: { type: Date, default: null },
    mensajesSri: { type: [sriMessageSchema], default: [] },

    isPreliminary: { type: Boolean, default: true },
    warnings: { type: [String], default: [] },
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

retentionVoucherSchema.index({ clinic: 1, serie: 1 }, { unique: true });
retentionVoucherSchema.index({ clinic: 1, claveAcceso: 1 }, { unique: true });
retentionVoucherSchema.index({ clinic: 1, purchaseInvoice: 1 }, { unique: true });

module.exports = mongoose.model('RetentionVoucher', retentionVoucherSchema);
