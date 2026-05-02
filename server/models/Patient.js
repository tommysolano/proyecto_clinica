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
      required: [true, 'La cédula es requerida'],
      trim: true,
    },
    firstName: {
      type: String,
      required: [true, 'El nombre es requerido'],
      trim: true,
    },
    lastName: {
      type: String,
      required: [true, 'El apellido es requerido'],
      trim: true,
    },
    email: { type: String, lowercase: true, trim: true },
    phone: { type: String, trim: true },
    whatsapp: { type: String, trim: true },
    birthDate: { type: Date },
    age: { type: Number, min: 0, max: 150 },
    gender: { type: String, enum: ['masculino', 'femenino', 'otro'] },
    address: { type: String, trim: true },
    notes: { type: String, trim: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true }
);

// Cédula única por clínica
patientSchema.index({ clinic: 1, cedula: 1 }, { unique: true });

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
