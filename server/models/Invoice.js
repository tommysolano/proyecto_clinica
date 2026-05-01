const mongoose = require('mongoose');

const sriMessageSchema = new mongoose.Schema(
  {
    identificador: String,
    mensaje: String,
    informacionAdicional: String,
    tipo: String,
  },
  { _id: false }
);

const invoiceSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    sale: { type: mongoose.Schema.Types.ObjectId, ref: 'Sale' },
    // Documento
    tipoDocumento: { type: String, enum: ['factura'], default: 'factura' },
    claveAcceso: { type: String, required: true, unique: true, index: true },
    secuencial: { type: String, required: true },
    estab: { type: String, required: true },
    ptoEmi: { type: String, required: true },
    ambiente: { type: String, enum: ['1', '2'], required: true },
    fechaEmision: { type: String, required: true }, // DD/MM/YYYY
    // Estados
    // EN_COLA: pendiente de envío al SRI
    // RECIBIDA: SRI la recibió pero aún no autoriza
    // EN_PROCESO: el SRI la está procesando
    // AUTORIZADO: válida fiscalmente
    // NO_AUTORIZADO: rechazada por el SRI
    // DEVUELTA: devuelta en recepción
    // ERROR: error técnico
    // ANULADA: marcada como anulada por el contribuyente (proceso SRI portal)
    estado: {
      type: String,
      enum: [
        'EN_COLA',
        'RECIBIDA',
        'EN_PROCESO',
        'AUTORIZADO',
        'NO_AUTORIZADO',
        'DEVUELTA',
        'ERROR',
        'ANULADA',
      ],
      default: 'EN_COLA',
    },
    numeroAutorizacion: { type: String, default: null },
    fechaAutorizacion: { type: Date, default: null },
    // XML
    xmlFirmado: { type: String, default: null },
    xmlAutorizado: { type: String, default: null },
    // Comprador
    tipoIdentificacionComprador: { type: String },
    razonSocialComprador: { type: String },
    identificacionComprador: { type: String },
    direccionComprador: { type: String },
    emailComprador: { type: String },
    telefonoComprador: { type: String },
    // Totales
    subtotal: { type: Number, default: 0 },
    iva: { type: Number, default: 0 },
    total: { type: Number, default: 0 },
    totalSinImpuestos: { type: Number, default: 0 },
    totalDescuento: { type: Number, default: 0 },
    totalImpuesto: { type: Number, default: 0 },
    importeTotal: { type: Number, default: 0 },
    formaPago: { type: String },
    items: { type: Array, default: [] },
    // Reintentos / mensajes
    reintentos: { type: Number, default: 0 },
    proximoReintento: { type: Date, default: null },
    mensajesSri: { type: [sriMessageSchema], default: [] },
    errorUltimo: { type: String, default: null },
    // Anulación
    anuladaAt: { type: Date, default: null },
    anuladaBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    motivoAnulacion: { type: String, default: null },
    xmlAnulacion: { type: String, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

invoiceSchema.virtual('numeroFactura').get(function () {
  return `${this.estab}-${this.ptoEmi}-${this.secuencial}`;
});

invoiceSchema.set('toJSON', { virtuals: true });
invoiceSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Invoice', invoiceSchema);
