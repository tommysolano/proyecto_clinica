const mongoose = require('mongoose');

const yesNoDetailSchema = new mongoose.Schema(
  {
    value: { type: Boolean, default: false },
    detail: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const recetaItemSchema = new mongoose.Schema(
  {
    // Referencia al producto/medicamento del inventario (categoría 'medicamento' o 'servicio'/'programa').
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: { type: String, trim: true }, // snapshot del nombre por si el producto cambia
    quantity: { type: Number, default: 1, min: 0 },
    dose: { type: String, trim: true, default: '' },         // ej: 500mg
    frequency: { type: String, trim: true, default: '' },    // ej: cada 8 horas
    duration: { type: String, trim: true, default: '' },     // ej: 7 días
    instructions: { type: String, trim: true, default: '' }, // ej: tomar después de comer
    // Marca interna para identificar si este ítem corresponde a un servicio/programa
    // y debe disparar la creación automática del tratamiento.
    isService: { type: Boolean, default: false },
  },
  { _id: true }
);

const followUpSchema = new mongoose.Schema(
  {
    fecha: { type: Date, required: true, default: Date.now },
    // "motivo de consulta" reemplaza al antiguo "descripcion".
    // Mantenemos `descripcion` como alias por retrocompatibilidad de datos.
    motivoConsulta: { type: String, trim: true },
    descripcion: { type: String, trim: true },
    // Antes era "Recomendaciones"; ahora se llama "Estudio o síntomas".
    // Mantenemos el campo `recomendaciones` por retrocompatibilidad pero
    // exponemos también `estudioSintomas` (alias funcional en el cliente).
    recomendaciones: { type: String, trim: true },
    estudioSintomas: { type: String, trim: true },
    // Antes "receta" era texto libre; ahora soportamos items estructurados del inventario.
    receta: { type: String, trim: true }, // legacy / texto libre opcional
    recetaItems: { type: [recetaItemSchema], default: [] },
    // Reemplaza al campo "treatment" (ref). Ahora se captura como texto.
    observaciones: { type: String, trim: true },
    // Mantenemos compat con tratamientos referenciados (auto-creados a partir de la receta).
    treatment: { type: mongoose.Schema.Types.ObjectId, ref: 'Treatment', default: null },
    autoTreatmentCreated: { type: mongoose.Schema.Types.ObjectId, ref: 'Treatment' },
    valor: { type: Number, default: 0, min: 0 },
    metodoPago: {
      type: String,
      enum: ['efectivo', 'tarjeta', 'transferencia', 'otro', ''],
      default: '',
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

const clinicalRecordSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    patient: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Patient',
      required: true,
    },
    // Ficha técnica
    fecha: { type: Date, default: Date.now },
    nombre: { type: String, trim: true },
    direccion: { type: String, trim: true },
    edad: { type: Number, min: 0, max: 150 },
    cedula: { type: String, trim: true },
    celular: { type: String, trim: true },
    tomaMedicamentos: { type: yesNoDetailSchema, default: () => ({}) },
    tieneAlergias: { type: yesNoDetailSchema, default: () => ({}) },
    tieneCirugias: { type: yesNoDetailSchema, default: () => ({}) },
    // Antecedentes ampliados
    antecedentesFamiliares: { type: String, trim: true, default: '' },
    antecedentesPatologicos: { type: String, trim: true, default: '' },
    // Seguimiento
    followUps: { type: [followUpSchema], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

clinicalRecordSchema.index({ clinic: 1, patient: 1 }, { unique: true });

module.exports = mongoose.model('ClinicalRecord', clinicalRecordSchema);
