const mongoose = require('mongoose');

/**
 * Rastro de CADA evaluación de disparador de workflow por evento de dominio:
 * dice por qué un evento (cita agendada, pago, etc.) inscribió o NO inscribió
 * al paciente. Antes, un salto por duplicado o por filtro de audiencia/servicio
 * era invisible ("agendé una cita y no pasó nada") — esto lo hace visible en
 * Workflows → Actividad. Se limpia solo (TTL 30 días).
 */
const workflowTriggerEventSchema = new mongoose.Schema({
  clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true },
  workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow', required: true },
  patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
  patientName: { type: String, trim: true, default: '' },
  eventType: { type: String, trim: true, default: '' }, // appointment_created, payment_received…
  decision: {
    type: String,
    enum: ['enrolled', 'skipped_duplicate', 'no_match'],
    required: true,
  },
  detail: { type: String, trim: true, default: '' },
  createdAt: { type: Date, default: Date.now, expires: 60 * 60 * 24 * 30 },
});

workflowTriggerEventSchema.index({ workflow: 1, createdAt: -1 });

module.exports = mongoose.model('WorkflowTriggerEvent', workflowTriggerEventSchema);
