const mongoose = require('mongoose');
const crypto = require('crypto');

/**
 * Registro de un email enviado, con tracking de apertura y clic.
 * El pixel de apertura y el redirector de clics referencian `trackingId`.
 */
const emailSendSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    campaign: { type: mongoose.Schema.Types.ObjectId, ref: 'Campaign', default: null, index: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
    to: { type: String, trim: true, default: '' },
    subject: { type: String, trim: true, default: '' },
    trackingId: { type: String, required: true, unique: true, index: true },
    status: { type: String, enum: ['sent', 'opened', 'clicked'], default: 'sent', index: true },
    openedAt: { type: Date, default: null },
    clickedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

emailSendSchema.statics.newTrackingId = () => crypto.randomBytes(16).toString('hex');

module.exports = mongoose.model('EmailSend', emailSendSchema);
