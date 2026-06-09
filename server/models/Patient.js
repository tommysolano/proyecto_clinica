const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    cedula: {
      type: String,
      trim: true,
      default: '',
    },
    firstName: {
      type: String,
      required: [true, 'El nombre es requerido'],
      trim: true,
      uppercase: true,
    },
    lastName: {
      type: String,
      required: [true, 'El apellido es requerido'],
      trim: true,
      uppercase: true,
    },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    whatsapp: { type: String, trim: true },
    birthDate: { type: Date },
    age: { type: Number, min: 0, max: 150 },
    gender: { type: String, enum: ['masculino', 'femenino', 'otro'] },
    address: { type: String, trim: true },
    notes: { type: String, trim: true },
    // De dónde viene el paciente: anuncio, referido, recepción, orgánico
    source: {
      type: String,
      enum: ['anuncio', 'referido', 'recepcion', 'organico', ''],
      default: '',
    },
    sourceDetail: { type: String, trim: true },
    // Persona que refirió al paciente (cuando source === 'referido').
    // Puede ser un paciente o un miembro del personal; guardamos snapshot del nombre.
    referredByName: { type: String, trim: true, default: '' },
    referredById: { type: mongoose.Schema.Types.ObjectId, default: null },
    referredByType: { type: String, enum: ['patient', 'user', ''], default: '' },
    // Antecedentes
    antecedentesFamiliares: { type: String, trim: true, default: '' },
    antecedentesPatologicos: { type: String, trim: true, default: '' },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Cédula única solo cuando está presente (sparse permite varios documentos sin cédula).
patientSchema.index(
  { cedula: 1 },
  { unique: true, partialFilterExpression: { cedula: { $type: 'string', $ne: '' } } }
);

patientSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

// Edad calculada (prioriza birthDate). Si no hay birthDate, usa el campo age guardado.
patientSchema.virtual('computedAge').get(function () {
  if (this.birthDate) {
    const diff = Date.now() - new Date(this.birthDate).getTime();
    const ageDate = new Date(diff);
    return Math.abs(ageDate.getUTCFullYear() - 1970);
  }
  return this.age ?? null;
});

patientSchema.set('toJSON', { virtuals: true });
patientSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('Patient', patientSchema);
