const mongoose = require('mongoose');

const appointmentServiceSchema = new mongoose.Schema(
  {
    product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
    name: String,
    price: Number,
  },
  { _id: false }
);

// Registro de cada reagendamiento (quien, cuando, fecha/horario anterior y razón).
const rescheduleEntrySchema = new mongoose.Schema(
  {
    previousDate: { type: Date, required: true },
    previousStartTime: { type: String },
    previousEndTime: { type: String },
    newDate: { type: Date, required: true },
    newStartTime: { type: String },
    newEndTime: { type: String },
    rescheduledBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    rescheduledByName: { type: String },
    rescheduledByRole: { type: String },
    reason: { type: String, trim: true },
    at: { type: Date, default: Date.now },
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
    // Consultorio (sala) físico donde se atenderá la cita
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
    // Estados ampliados:
    //   pendiente   - agendada / por confirmar
    //   confirmada  - paciente confirmó que asistirá
    //   asistida    - el paciente llegó (registrada por enfermería/recepción)
    //   no_asistio  - no se presentó
    //   cancelada   - cancelada por el paciente o la clínica
    //   completada  - ya atendida por el doctor
    status: {
      type: String,
      enum: ['pendiente', 'confirmada', 'asistida', 'no_asistio', 'cancelada', 'completada'],
      default: 'pendiente',
    },
    // Marca si abonó por adelantado (check al agendar)
    paidInAdvance: { type: Boolean, default: false },
    advanceAmount: { type: Number, default: 0, min: 0 },
    reason: { type: String, trim: true },
    notes: { type: String, trim: true },
    diagnosis: { type: String, trim: true },
    treatment: { type: String, trim: true },
    // Servicios solicitados / a facturar (referenciados desde inventario)
    services: { type: [appointmentServiceSchema], default: [] },
    // Marca si es la primera cita del paciente (registrado por primera vez).
    // Se calcula al crear: true si el paciente no tenía citas previas.
    isFirstVisit: { type: Boolean, default: false },
    // Cronómetro de consulta (lo arranca el doctor desde la UI).
    consultationStartedAt: { type: Date },
    consultationEndedAt: { type: Date },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    // Rol del usuario que creó la cita (snapshot, útil para comisiones de call_center)
    createdByRole: { type: String },
    // Historial de reagendamientos
    rescheduleHistory: { type: [rescheduleEntrySchema], default: [] },
    // Origen de la cita: si nació de una derivación o se agendó suelta
    origin: {
      type: String,
      enum: ['referral', 'standalone', 'treatment'],
      default: 'standalone',
    },
    referral: { type: mongoose.Schema.Types.ObjectId, ref: 'Referral', default: null },
    treatmentRef: { type: mongoose.Schema.Types.ObjectId, ref: 'Treatment', default: null },
  },
  { timestamps: true }
);

// Mapeo de estados legacy. Mantenemos compatibilidad pero ahora preservamos
// los estados detallados (cancelada / no_asistio) que antes se descartaban.
const LEGACY_STATUS_MAP = {
  programada: 'pendiente',
  en_curso: 'confirmada',
};

const normalizeStatus = (doc) => {
  if (doc && LEGACY_STATUS_MAP[doc.status]) doc.status = LEGACY_STATUS_MAP[doc.status];
};

appointmentSchema.post('find', function (docs) {
  if (Array.isArray(docs)) docs.forEach(normalizeStatus);
});
appointmentSchema.post('findOne', function (doc) { normalizeStatus(doc); });
appointmentSchema.post('findOneAndUpdate', function (doc) { normalizeStatus(doc); });

module.exports = mongoose.model('Appointment', appointmentSchema);
