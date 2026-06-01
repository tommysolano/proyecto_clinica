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

// Un disparador (activador) del flujo. Un flujo puede tener VARIOS.
const flowTriggerSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['keyword', 'welcome', 'incoming'], default: 'keyword' },
    keywords: { type: [String], default: [] },
    matchType: { type: String, enum: ['contains', 'exact', 'starts'], default: 'contains' },
    audience: { type: String, enum: ['all', 'new', 'existing'], default: 'all' },
    label: { type: String, default: '' }, // nombre opcional del activador
  },
  { _id: true }
);

/**
 * Flujo de mensajes automáticos (estilo Daplox): uno o varios disparadores +
 * una secuencia ordenada de pasos. Vive dentro de una carpeta.
 */
const messageFlowSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    folder: { type: String, trim: true, default: 'General' },
    name: { type: String, required: true, trim: true },
    active: { type: Boolean, default: false }, // borrador por defecto

    // Varios disparadores: el flujo se ejecuta si CUALQUIERA coincide.
    triggers: { type: [flowTriggerSchema], default: [] },
    // Compatibilidad: disparador único antiguo (si triggers está vacío se usa este).
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

    // Horario en el que el flujo puede ejecutarse.
    days: { type: [Number], default: [0, 1, 2, 3, 4, 5, 6] }, // 0=dom..6=sáb
    hourFrom: { type: String, default: '00:00' },
    hourTo: { type: String, default: '23:59' },

    steps: { type: [flowStepSchema], default: [] },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MessageFlow', messageFlowSchema);
