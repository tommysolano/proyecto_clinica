const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Solicitud de reseña (reputación). Se crea por un workflow post-visita y envía
 * al paciente un enlace público para calificar (1-5). Si la calificación es alta
 * (>= reputation.minRating de la clínica) se le redirige a Google a dejar reseña;
 * si es baja, se captura feedback interno (no público).
 */
const reviewRequestSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null, index: true },
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
    conversation: { type: mongoose.Schema.Types.ObjectId, ref: 'Conversation', default: null },
    token: { type: String, required: true, unique: true, index: true },
    channel: { type: String, enum: ['whatsapp', 'email'], default: 'whatsapp' },
    status: {
      type: String,
      enum: ['sent', 'clicked', 'rated', 'redirected'],
      default: 'sent',
      index: true,
    },
    rating: { type: Number, default: null, min: 1, max: 5 },
    feedback: { type: String, default: '' },
    sentAt: { type: Date, default: Date.now },
    clickedAt: { type: Date, default: null },
    ratedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

reviewRequestSchema.statics.newToken = () => crypto.randomBytes(16).toString('hex');

module.exports = mongoose.model('ReviewRequest', reviewRequestSchema);
