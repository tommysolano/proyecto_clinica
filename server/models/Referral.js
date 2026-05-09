const mongoose = require('mongoose');

/**
 * Derivación = un doctor envía un paciente a otro doctor / especialidad / consultorio.
 */
const referralSchema = new mongoose.Schema(
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
      index: true,
    },
    fromDoctor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    toDoctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    specialty: { type: String, trim: true },
    reason: { type: String, trim: true },
    notes: { type: String, trim: true },
    // Cita opcional generada a partir de la derivación
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment' },
    status: {
      type: String,
      enum: ['pendiente', 'agendada', 'atendida', 'cancelada'],
      default: 'pendiente',
    },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Referral', referralSchema);
