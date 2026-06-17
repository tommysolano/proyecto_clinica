const mongoose = require('mongoose');

/**
 * Mensaje en cola para envío diferido/masivo. Lo crea una campaña (o, más
 * adelante, un workflow) y lo procesa un job que respeta rate limit + opt-out
 * + ventana de 24h (vía utils/messaging.js).
 *
 * idempotencyKey evita duplicar el mismo envío al reintentar el job o al
 * recrear una campaña: `${campaign}:${patient|phone}`.
 */
const scheduledMessageSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },
    channel: { type: String, enum: ['whatsapp', 'email', 'sms'], default: 'whatsapp' },
    to: { type: String, trim: true, required: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
    contactName: { type: String, trim: true, default: '' },
    // Contenido: texto libre y/o plantilla.
    body: { type: String, default: '' },
    subject: { type: String, default: '' }, // solo email
    templateName: { type: String, trim: true, default: '' },
    templateLanguage: { type: String, trim: true, default: 'es' },
    templateVars: { type: mongoose.Schema.Types.Mixed, default: null },
    scheduledFor: { type: Date, default: Date.now, index: true },
    status: {
      type: String,
      enum: ['queued', 'sent', 'failed', 'skipped', 'cancelled'],
      default: 'queued',
      index: true,
    },
    reason: { type: String, trim: true, default: '' }, // motivo de skip/fail
    errorCode: { type: String, trim: true, default: '' },
    message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
    attempts: { type: Number, default: 0 },
    idempotencyKey: { type: String, trim: true, default: '' },
  },
  { timestamps: true }
);

scheduledMessageSchema.index({ status: 1, scheduledFor: 1 });
scheduledMessageSchema.index(
  { clinic: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string', $ne: '' } } }
);

module.exports = mongoose.model('ScheduledMessage', scheduledMessageSchema);
