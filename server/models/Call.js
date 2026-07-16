const mongoose = require('mongoose');

/**
 * Llamada de voz de WhatsApp (Calling API de Meta), entrante o saliente.
 *
 * Solo existe para números Cloud API: una sesión QR (WhatsApp Web) no puede ni
 * hacer ni recibir llamadas, así que el botón de llamar no se ofrece en esos chats.
 *
 * El audio NO pasa por el servidor: va por WebRTC directo entre el navegador del
 * agente y WhatsApp. Aquí solo se guarda la señalización y el historial (quién
 * llamó a quién, cuándo y cuánto duró), que es lo que la clínica necesita auditar.
 */
const callSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', required: true, index: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
    whatsappAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappAccount', default: null },

    // Identificador de la llamada en WhatsApp (wacid.*). Es la clave para casar
    // los eventos del webhook con la llamada que el agente tiene en pantalla.
    callId: { type: String, trim: true, index: true },
    direction: { type: String, enum: ['in', 'out'], required: true },
    phone: { type: String, trim: true, default: '' },

    // ringing   → sonando (saliente: esperando que conteste; entrante: sin atender)
    // active    → audio conectado
    // completed → colgada normalmente
    // rejected  → rechazada por el agente o por el contacto
    // missed    → entrante que nadie atendió
    // failed    → error de red/proveedor
    status: {
      type: String,
      enum: ['ringing', 'active', 'completed', 'rejected', 'missed', 'failed'],
      default: 'ringing',
      index: true,
    },

    // Agente que la atendió/originó (queda vacío en una entrante no atendida).
    agent: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    agentName: { type: String, trim: true, default: '' },

    startedAt: { type: Date, default: Date.now },
    connectedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    durationSec: { type: Number, default: 0 },

    errorMessage: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

callSchema.index({ conversation: 1, createdAt: -1 });

module.exports = mongoose.model('Call', callSchema);
