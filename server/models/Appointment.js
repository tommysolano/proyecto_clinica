const mongoose = require('mongoose');

const appointmentServiceSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    price: Number,
  },
  { _id: false }
);

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
    // Servicios solicitados / a facturar (referenciados desde inventario)
    services: { type: [appointmentServiceSchema], default: [] },
    // Marca si es la primera cita del paciente (registrado por primera vez).
    // Se calcula al crear: true si el paciente no tenía citas previas.
    isFirstVisit: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Rol del usuario que creó la cita (snapshot, útil para comisiones de call_center)
    createdByRole: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Appointment', appointmentSchema);
