const mongoose = require('mongoose');

const invoicingConfigSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      unique: true,
    },
    isActive: { type: Boolean, default: false },
    // Datos tributarios
    ruc: {
      type: String,
      validate: {
        validator: (v) => !v || /^\d{13}$/.test(v),
        message: 'RUC debe tener 13 dígitos',
      },
    },
    razonSocial: { type: String, maxlength: 300 },
    nombreComercial: { type: String, maxlength: 300 },
    direccionMatriz: { type: String, maxlength: 300 },
    direccionEstablecimiento: { type: String, maxlength: 300 },
    establecimiento: {
      type: String,
      validate: {
        validator: (v) => !v || /^\d{1,3}$/.test(v),
        message: 'Establecimiento debe ser máximo 3 dígitos',
      },
      default: '001',
    },
    puntoEmision: {
      type: String,
      validate: {
        validator: (v) => !v || /^\d{1,3}$/.test(v),
        message: 'Punto de emisión debe ser máximo 3 dígitos',
      },
      default: '001',
    },
    secuencial: { type: Number, default: 1, min: 1, max: 999999999 },
    // Ambiente: "1" = Pruebas, "2" = Producción
    ambiente: { type: String, enum: ['1', '2'], default: '1' },
    obligadoContabilidad: { type: String, enum: ['SI', 'NO'], default: 'NO' },
    agenteRetencion: { type: String, default: null },
    contribuyenteEspecial: { type: String, default: null },
    // Certificado P12
    certificateFilename: { type: String, default: null }, // archivo en storage local
    certificatePassword: { type: String, default: null }, // encriptada (AES-256-CBC)
    certificateInfo: {
      validFrom: Date,
      validTo: Date,
      issuer: String,
      subject: String,
      serialNumber: String,
    },
    // Email para envío de RIDE/XML
    emailRemitente: { type: String, trim: true },
    smtpHost: { type: String, trim: true },
    smtpPort: { type: Number },
    smtpUser: { type: String, trim: true },
    smtpPassword: { type: String, trim: true },
    invoiceCount: { type: Number, default: 0 },
    lastInvoiceDate: { type: Date, default: null },
  },
  { timestamps: true }
);

invoicingConfigSchema.methods.reserveSequential = async function () {
  const seq = String(this.secuencial).padStart(9, '0');
  this.secuencial += 1;
  this.invoiceCount += 1;
  this.lastInvoiceDate = new Date();
  await this.save();
  return seq;
};

invoicingConfigSchema.methods.isComplete = function () {
  return !!(
    this.certificateFilename &&
    this.certificatePassword &&
    this.ruc &&
    this.razonSocial &&
    this.direccionMatriz &&
    this.establecimiento &&
    this.puntoEmision &&
    this.ambiente
  );
};

invoicingConfigSchema.virtual('ambienteLabel').get(function () {
  return this.ambiente === '2' ? 'Producción' : 'Pruebas';
});

invoicingConfigSchema.set('toJSON', { virtuals: true });
invoicingConfigSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('InvoicingConfig', invoicingConfigSchema);
