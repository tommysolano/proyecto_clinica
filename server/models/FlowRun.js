const mongoose = require('mongoose');

/**
 * Ejecución en curso de un flujo para una conversación. Permite manejar los
 * pasos de "espera" (wait): el procesador reanuda el flujo cuando llega nextRunAt.
 */
const flowRunSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    flow: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageFlow', required: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true },
    stepIndex: { type: Number, default: 0 },
    status: { type: String, enum: ['pending', 'done', 'cancelled'], default: 'pending', index: true },
    nextRunAt: { type: Date, default: Date.now, index: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('FlowRun', flowRunSchema);
