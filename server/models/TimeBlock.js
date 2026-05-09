const mongoose = require('mongoose');

/**
 * Bloqueo de horario / fecha. Lo crea el admin para impedir que se agenden citas.
 * Puede aplicar a toda la clínica, a un doctor, o a un consultorio específico.
 */
const timeBlockSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    // Si todos están vacíos, bloquea para toda la clínica
    doctor: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    room: { type: mongoose.Schema.Types.ObjectId, ref: 'Room', default: null },
    startDate: { type: Date, required: true },
    endDate: { type: Date, required: true },
    // Si allDay = true se ignoran startTime/endTime
    allDay: { type: Boolean, default: false },
    startTime: { type: String, default: null }, // 'HH:MM'
    endTime: { type: String, default: null },
    reason: { type: String, trim: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('TimeBlock', timeBlockSchema);
