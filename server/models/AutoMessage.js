const mongoose = require('mongoose');

/**
 * Mensaje automático que se envía bajo ciertos criterios.
 * - trigger:
 *    welcome: al crearse una conversación nueva
 *    incoming: cuando llega un mensaje entrante
 *    out_of_hours: cuando llega fuera del horario configurado
 *    scheduled: a una hora del día específica
 * - days: días de la semana en los que aplica (0 = domingo)
 * - hourFrom / hourTo: rango horario (HH:MM) cuando aplica
 * - audience: 'all' | 'new' (nuevo contacto sin patient) | 'existing' (paciente)
 */
const autoMessageSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    name: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    trigger: {
      type: String,
      enum: ['welcome', 'incoming', 'out_of_hours', 'scheduled'],
      default: 'incoming',
    },
    audience: {
      type: String,
      enum: ['all', 'new', 'existing'],
      default: 'all',
    },
    active: { type: Boolean, default: true },
    days: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0=dom..6=sáb
    hourFrom: { type: String, default: '00:00' },
    hourTo: { type: String, default: '23:59' },
    scheduledAt: { type: String, default: '' }, // HH:MM cuando trigger=scheduled
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AutoMessage', autoMessageSchema);
