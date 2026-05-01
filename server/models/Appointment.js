const mongoose = require('mongoose');

const appointmentSchema = new mongoose.Schema(
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
      required: [true, 'El paciente es requerido'],
    },
    doctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'El doctor es requerido'],
    },
    date: { type: Date, required: [true, 'La fecha es requerida'] },
    startTime: { type: String, required: [true, 'La hora de inicio es requerida'] },
    endTime: { type: String, required: [true, 'La hora de fin es requerida'] },
    status: {
      type: String,
      enum: ['programada', 'confirmada', 'en_curso', 'completada', 'cancelada', 'no_asistio'],
      default: 'programada',
    },
    reason: { type: String, trim: true },
    notes: { type: String, trim: true },
    diagnosis: { type: String, trim: true },
    treatment: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Appointment', appointmentSchema);
