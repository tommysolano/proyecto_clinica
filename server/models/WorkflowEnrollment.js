const mongoose = require('mongoose');

/**
 * Una inscripción = la ejecución de un Workflow para un paciente concreto,
 * disparada por un evento. Avanza por los pasos hasta encontrar una espera
 * (status 'waiting' + nextRunAt) o terminar (done/cancelled).
 *
 * context guarda datos del evento que originó la inscripción (p.ej. la fecha de
 * la cita para los pasos wait_until) y el teléfono de destino.
 */
const workflowEnrollmentSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    workflow: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow', required: true, index: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null, index: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
    stepIndex: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['active', 'waiting', 'done', 'cancelled'],
      default: 'active',
      index: true,
    },
    nextRunAt: { type: Date, default: Date.now, index: true },
    // true mientras un paso wait_reply espera la respuesta del paciente.
    waitingForReply: { type: Boolean, default: false, index: true },
    context: { type: mongoose.Schema.Types.Mixed, default: {} },
    lastError: { type: String, default: '' },
  },
  { timestamps: true }
);

workflowEnrollmentSchema.index({ status: 1, nextRunAt: 1 });
// Anti-duplicado: una inscripción activa por (workflow, patient).
workflowEnrollmentSchema.index(
  { workflow: 1, patient: 1, status: 1 },
  { partialFilterExpression: { status: { $in: ['active', 'waiting'] } } }
);

module.exports = mongoose.model('WorkflowEnrollment', workflowEnrollmentSchema);
