const mongoose = require('mongoose');

/**
 * Campaña: envío masivo (inmediato o programado) a los pacientes de un Segmento,
 * usando texto libre y/o una plantilla. La ejecución se materializa en
 * documentos ScheduledMessage que procesa un job.
 *
 * stats refleja el resultado agregado de los ScheduledMessage de la campaña.
 */
const campaignSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    name: { type: String, required: true, trim: true },
    channel: { type: String, enum: ['whatsapp', 'email'], default: 'whatsapp' },
    segment: { type: mongoose.Schema.Types.ObjectId, ref: 'Segment', default: null },
    template: { type: mongoose.Schema.Types.ObjectId, ref: 'MessageTemplate', default: null },
    templateName: { type: String, trim: true, default: '' },
    templateLanguage: { type: String, trim: true, default: 'es' },
    body: { type: String, default: '' },
    subject: { type: String, default: '' }, // solo email
    scheduledFor: { type: Date, default: Date.now },
    // Tope de destinatarios (null = sin tope). Recorta el segmento al crear.
    maxRecipients: { type: Number, default: null, min: 1 },
    // Envío por lotes (goteo): `batchSize` destinatarios cada `intervalMinutes`.
    // batchSize=0 → todo de una vez.
    drip: {
      batchSize: { type: Number, default: 0, min: 0 },
      intervalMinutes: { type: Number, default: 60, min: 1 },
    },
    status: {
      type: String,
      enum: ['draft', 'scheduled', 'sending', 'done', 'cancelled'],
      default: 'draft',
      index: true,
    },
    stats: {
      targeted: { type: Number, default: 0 },
      queued: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      opened: { type: Number, default: 0 }, // solo email (tracking de apertura)
      clicked: { type: Number, default: 0 }, // solo email (tracking de clic)
    },
    startedAt: { type: Date, default: null },
    finishedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Campaign', campaignSchema);
