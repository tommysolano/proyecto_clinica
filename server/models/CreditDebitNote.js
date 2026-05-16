const mongoose = require('mongoose');

/**
 * Nota de crédito / débito emitida (relacionada a una factura de venta o compra).
 */
const creditDebitNoteSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    kind: { type: String, enum: ['NC', 'ND'], required: true }, // NC=crédito, ND=débito
    direction: { type: String, enum: ['EMITIDA', 'RECIBIDA'], required: true },
    // Documento que modifica
    refModel: { type: String, enum: ['Invoice', 'PurchaseInvoice'], required: true },
    refDoc: { type: mongoose.Schema.Types.ObjectId, refPath: 'refModel', required: true },
    serieAfecta: String, // serie del documento original
    fechaEmisionAfecta: Date,
    // Propios
    estab: String,
    ptoEmi: String,
    secuencial: String,
    serie: String,
    claveAcceso: { type: String, index: true },
    fechaEmision: { type: Date, required: true },
    autorizacion: String,
    motivo: { type: String, default: '' },
    items: { type: Array, default: [] },
    subtotal: { type: Number, default: 0 },
    iva: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    estado: {
      type: String,
      enum: ['EN_COLA', 'RECIBIDA', 'EN_PROCESO', 'AUTORIZADO', 'NO_AUTORIZADO', 'DEVUELTA', 'ERROR', 'ANULADA', 'REGISTRADA'],
      default: 'REGISTRADA',
    },
    xmlFirmado: String,
    xmlAutorizado: String,
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CreditDebitNote', creditDebitNoteSchema);
