const mongoose = require('mongoose');

/**
 * Un PASO del flujo (nodo del diagrama). Tipos:
 *  - message: envía un mensaje al cliente.
 *  - wait: espera N minutos antes de continuar al siguiente paso.
 *  - opportunity: crea/actualiza una oportunidad en la conversación.
 */
const flowStepSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['message', 'wait', 'opportunity'], required: true },
    // message
    body: { type: String, default: '' },
    // wait
    waitMinutes: { type: Number, default: 0, min: 0 },
    // opportunity
    opportunityStage: {
      type: String,
      enum: ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'],
      default: 'nuevo',
    },
  },
  { _id: true }
);

/**
 * Flujo de mensajes automáticos (estilo Daplox): un disparador + una secuencia
 * ordenada de pasos. Vive dentro de una carpeta.
 */
const messageFlowSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    folder: { type: String, trim: true, default: 'General' },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: false }, // borrador por defecto

    trigger: {
      type: {
        type: String,
        enum: ['keyword', 'welcome', 'incoming'],
        default: 'keyword',
      },
      keywords: { type: [String], default: [] },
      matchType: { type: String, enum: ['contains', 'exact', 'starts'], default: 'contains' },
      audience: { type: String, enum: ['all', 'new', 'existing'], default: 'all' },
    },

    steps: { type: [flowStepSchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MessageFlow', messageFlowSchema);
