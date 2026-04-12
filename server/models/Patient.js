const mongoose = require('mongoose');

const patientSchema = new mongoose.Schema({
  cedula: {
    type: String,
    required: [true, 'La cédula es requerida'],
    unique: true,
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
  email: {
    type: String,
    lowercase: true,
    trim: true,
  },
  phone: {
    type: String,
    trim: true,
  },
  whatsapp: {
    type: String,
    trim: true,
  },
  birthDate: {
    type: Date,
  },
  gender: {
    type: String,
    enum: ['masculino', 'femenino', 'otro'],
  },
  address: {
    type: String,
    trim: true,
  },
  bloodType: {
    type: String,
    enum: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-', ''],
    default: '',
  },
  allergies: {
    type: String,
    trim: true,
  },
  notes: {
    type: String,
    trim: true,
  },
  active: {
    type: Boolean,
    default: true,
  },
}, { timestamps: true });

patientSchema.virtual('fullName').get(function () {
  return `${this.firstName} ${this.lastName}`;
});

patientSchema.set('toJSON', { virtuals: true });

module.exports = mongoose.model('Patient', patientSchema);
