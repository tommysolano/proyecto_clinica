const mongoose = require('mongoose');

const yesNoDetailSchema = new mongoose.Schema(
  {
    value: { type: Boolean, default: false },
    detail: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const followUpSchema = new mongoose.Schema(
  {
    fecha: { type: Date, required: true, default: Date.now },
    // "motivo de consulta" reemplaza al antiguo "descripcion".
    // Mantenemos `descripcion` como alias por retrocompatibilidad de datos.
    motivoConsulta: { type: String, trim: true },
    descripcion: { type: String, trim: true },
    recomendaciones: { type: String, trim: true },
    receta: { type: String, trim: true },
    treatment: { type: mongoose.Schema.Types.ObjectId, ref: 'Treatment', default: null },
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
