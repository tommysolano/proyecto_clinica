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
    // Carpeta para organizar flujos (varios flujos por carpeta).
    folder: { type: String, trim: true, default: 'General' },
    trigger: {
      type: String,
      // 'keyword' = responde según lo que escribe el cliente (coincidencia de texto).
      enum: ['welcome', 'incoming', 'keyword', 'out_of_hours', 'scheduled'],
      default: 'incoming',
    },
    // Palabras/frases que disparan la regla (cuando trigger='keyword').
    keywords: { type: [String], default: [] },
    matchType: {
      type: String,
      enum: ['contains', 'exact', 'starts'],
      default: 'contains',
    },
    audience: {
      type: String,
      enum: ['all', 'new', 'existing'],
      default: 'all',
    },
    // Acción: crear oportunidad automáticamente cuando la regla coincide.
    createOpportunity: { type: Boolean, default: false },
    opportunityStage: {
      type: String,
      enum: ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'],
      default: 'nuevo',
    },
    // Orden de evaluación (menor = primero).
    order: { type: Number, default: 0 },
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
