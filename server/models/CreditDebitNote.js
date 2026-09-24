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
    // Las notas históricas de Contífico pueden no traer el comprobante afectado.
    // Se conservan igualmente para que los reportes fiscales no pierdan el documento;
    // las notas creadas desde la UI siguen validando la referencia en el controlador.
    refModel: { type: String, enum: ['Invoice', 'PurchaseInvoice'], default: null },
    refDoc: { type: mongoose.Schema.Types.ObjectId, refPath: 'refModel', default: null },
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
    // Tarifa aplicada (15, 12, 0…). Permite que las declaraciones SRI resten la nota de
    // crédito de la base de SU MISMA tarifa sin tener que inferirla del signo del IVA.
    ivaRate: { type: Number, default: null },
    // Desglose por tarifa de la nota (snapshot). Fuente preferida por el Formulario 104
    // para clasificar la resta; si viene en cero, el 104 infiere la tarifa desde el IVA.
    taxBreakdown: {
      base0: { type: Number, default: 0 },
      baseGravada: { type: Number, default: 0 },
      baseExento: { type: Number, default: 0 },
      baseNoObjeto: { type: Number, default: 0 },
      iva: { type: Number, default: 0 },
    },
    estado: {
      type: String,
      enum: ['EN_COLA', 'RECIBIDA', 'EN_PROCESO', 'AUTORIZADO', 'NO_AUTORIZADO', 'DEVUELTA', 'ERROR', 'ANULADA', 'REGISTRADA'],
      default: 'REGISTRADA',
    },
    xmlFirmado: String,
    xmlAutorizado: String,
    journalEntry: { type: mongoose.Schema.Types.ObjectId, ref: 'JournalEntry', default: null },
    // Trazabilidad e idempotencia de una nota importada. Los asientos históricos
    // se importan desde /contabilidad/asiento y por eso no se recrean al proyectar
    // esta ficha documental.
    sourceModel: { type: String, default: null },
    sourceRef: { type: mongoose.Schema.Types.ObjectId, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

creditDebitNoteSchema.index(
  { clinic: 1, sourceModel: 1, sourceRef: 1 },
  { unique: true, partialFilterExpression: { sourceModel: { $type: 'string' }, sourceRef: { $type: 'objectId' } } }
);

module.exports = mongoose.model('CreditDebitNote', creditDebitNoteSchema);
