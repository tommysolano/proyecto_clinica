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

// Detalle por tarifa de IVA dentro del desglose tributario de la factura.
const invoiceTaxRateSchema = new mongoose.Schema(
  {
    // Código SRI de porcentaje: 0=0%, 2=12%, 3=14%, 4=15%, 6=no objeto, 7=exento.
    codigoPorcentaje: String,
    rate: { type: Number, default: 0 },
    base: { type: Number, default: 0 },
    iva: { type: Number, default: 0 },
  },
  { _id: false }
);

// Snapshot tributario de la VENTA por tarifa de IVA, congelado al emitir la factura
// para que los reportes SRI (F104/ATS) separen ventas 0% y 15% sin depender de la
// venta origen (que podría cambiar). `computed:true` marca que es un snapshot real
// (no un fallback derivado de totales). Ver utils/invoiceTaxBreakdown.js.
const invoiceTaxBreakdownSchema = new mongoose.Schema(
  {
    base0: { type: Number, default: 0 }, // base tarifa 0%
    baseGravada: { type: Number, default: 0 }, // base con IVA (>0%, típ. 15%)
    baseExento: { type: Number, default: 0 },
    baseNoObjeto: { type: Number, default: 0 },
    iva: { type: Number, default: 0 }, // IVA generado sobre la base gravada
    rates: { type: [invoiceTaxRateSchema], default: undefined },
    computed: { type: Boolean, default: true },
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
    // Desglose por tarifa de IVA (snapshot al emitir). Ausente en facturas antiguas:
    // los reportes lo derivan por fallback desde totalSinImpuestos/totalImpuesto.
    taxBreakdown: { type: invoiceTaxBreakdownSchema, default: undefined },
    balance: { type: Number, default: 0 },
    paid: { type: Boolean, default: false },
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
