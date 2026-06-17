const mongoose = require('mongoose');

/**
 * Tarea/recordatorio de un agente del call center, normalmente ligada a una
 * conversación o paciente (ej. "llamar a Juan mañana 10am").
 */
const agentTaskSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    title: { type: String, required: true, trim: true },
    notes: { type: String, trim: true, default: '' },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    dueAt: { type: Date, default: null, index: true },
    status: { type: String, enum: ['open', 'done'], default: 'open', index: true },
    completedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('AgentTask', agentTaskSchema);
