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
    // Multi-sucursal: establecimientos y puntos de emisión disponibles para elegir al emitir
    // comprobantes (p.ej. retenciones). Si está vacío se usa el par único
    // establecimiento/puntoEmision de arriba (compatibilidad). Cada establecimiento tiene sus
    // propios puntos de emisión (001, 002, …).
    establishments: {
      type: [new mongoose.Schema({
        estab: { type: String, required: true }, // 001, 002, 003
        name: { type: String, default: '' },     // "Matriz", "Sucursal norte"…
        puntosEmision: { type: [String], default: ['001'] },
      }, { _id: false })],
      default: [],
    },
    // Secuencial de retenciones POR SERIE (estab-ptoEmi): clave "estab-ptoEmi" → PRÓXIMO número
    // a usar. Atómico (findOneAndUpdate $inc). El `retentionSequential` de arriba queda como
    // semilla del par por defecto para no reiniciar la numeración existente.
    retentionSeries: { type: Map, of: Number, default: () => ({}) },
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
    retentionSequential: { type: Number, default: 1, min: 1, max: 999999999 },
    retentionCount: { type: Number, default: 0 },
    lastRetentionDate: { type: Date, default: null },
    creditNoteSequential: { type: Number, default: 1, min: 1, max: 999999999 },
    creditNoteCount: { type: Number, default: 0 },
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

invoicingConfigSchema.methods.reserveRetentionSequential = async function () {
  // Compat: reserva sobre el par por defecto (establecimiento/puntoEmision de la config).
  return this.constructor.reserveRetentionSeries(this.clinic, this.establecimiento, this.puntoEmision);
};

/**
 * Establecimientos + puntos de emisión disponibles para elegir al emitir. Deriva del arreglo
 * `establishments`; si está vacío, cae al par único de la config. Nunca devuelve vacío.
 */
invoicingConfigSchema.methods.availableSeries = function () {
  const list = (this.establishments || []).filter((e) => e && e.estab);
  if (list.length) {
    return list.map((e) => ({
      estab: e.estab,
      name: e.name || '',
      puntosEmision: (e.puntosEmision && e.puntosEmision.length) ? e.puntosEmision : ['001'],
    }));
  }
  return [{ estab: this.establecimiento || '001', name: 'Matriz', puntosEmision: [this.puntoEmision || '001'] }];
};

/**
 * Reserva ATÓMICA del siguiente secuencial de retención para una SERIE (estab-ptoEmi).
 * Independiente por serie y sin duplicados en concurrencia (usa `$inc` sobre el mapa
 * `retentionSeries` del documento de config). Para el par por DEFECTO siembra la primera vez
 * desde el `retentionSequential` legacy, para no reiniciar la numeración ya emitida.
 * @returns {Promise<string>} secuencial de 9 dígitos ya reservado (no se repetirá).
 */
invoicingConfigSchema.statics.reserveRetentionSeries = async function (clinicId, estab, ptoEmi) {
  const e = String(estab || '001');
  const p = String(ptoEmi || '001');
  const key = `${e}-${p}`;
  const field = `retentionSeries.${key}`;
  const cfg = await this.findOne({ clinic: clinicId });
  if (!cfg) throw Object.assign(new Error('No hay configuración de facturación electrónica para esta clínica'), { status: 400 });

  // Semilla del par por defecto: la primera vez, arranca en el `retentionSequential` legacy.
  const seriesMap = cfg.retentionSeries || new Map();
  const yaTiene = seriesMap.get ? seriesMap.has(key) : Object.prototype.hasOwnProperty.call(seriesMap, key);
  if (!yaTiene) {
    const esDefault = e === String(cfg.establecimiento || '001') && p === String(cfg.puntoEmision || '001');
    const seed = esDefault ? Math.max(1, Number(cfg.retentionSequential) || 1) : 1;
    // `$exists:false` hace el set idempotente ante concurrencia (ambos fijan el mismo valor).
    await this.updateOne({ clinic: clinicId, [field]: { $exists: false } }, { $set: { [field]: seed } });
  }

  const updated = await this.findOneAndUpdate(
    { clinic: clinicId },
    { $inc: { [field]: 1 }, $set: { lastRetentionDate: new Date() } },
    { new: true }
  );
  // El valor tras el $inc es "próximo"; el reservado es el anterior.
  const proximo = Number(updated.retentionSeries.get(key));
  const reservado = proximo - 1;
  await this.updateOne({ clinic: clinicId }, { $inc: { retentionCount: 1 } });
  return String(reservado).padStart(9, '0');
};

invoicingConfigSchema.methods.reserveCreditNoteSequential = async function () {
  const seq = String(this.creditNoteSequential || 1).padStart(9, '0');
  this.creditNoteSequential = (this.creditNoteSequential || 1) + 1;
  this.creditNoteCount = (this.creditNoteCount || 0) + 1;
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
