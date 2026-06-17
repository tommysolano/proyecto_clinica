const mongoose = require('mongoose');

/**
 * Plantilla de mensaje reutilizable.
 * - channel 'whatsapp': se corresponde con una plantilla HSM aprobada por Meta
 *   (necesaria para iniciar conversación fuera de la ventana de 24h). El estado
 *   de aprobación se sincroniza desde la Graph API (`metaTemplateId`, `status`).
 * - channel 'email': plantilla propia (se usará en la fase de email marketing).
 *
 * `body` admite variables posicionales estilo WhatsApp: {{1}}, {{2}}... y/o
 * nombradas {{firstName}}. `variables` documenta cada una con un ejemplo.
 */
const templateButtonSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['quick_reply', 'url', 'phone'], default: 'quick_reply' },
    text: { type: String, trim: true, default: '' },
    url: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

const messageTemplateSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    channel: { type: String, enum: ['whatsapp', 'email'], default: 'whatsapp' },
    name: { type: String, required: true, trim: true },
    language: { type: String, trim: true, default: 'es' },
    category: {
      type: String,
      enum: ['MARKETING', 'UTILITY', 'AUTHENTICATION'],
      default: 'MARKETING',
    },
    // draft = aún no registrada en Meta; el resto refleja el estado de Meta.
    status: {
      type: String,
      enum: ['draft', 'pending', 'approved', 'rejected', 'disabled'],
      default: 'draft',
      index: true,
    },
    // Solo para email
    subject: { type: String, trim: true, default: '' },
    headerType: { type: String, enum: ['none', 'text', 'image', 'document'], default: 'none' },
    headerText: { type: String, trim: true, default: '' },
    body: { type: String, required: true, trim: true },
    footer: { type: String, trim: true, default: '' },
    buttons: { type: [templateButtonSchema], default: [] },
    variables: {
      type: [
        {
          key: { type: String, trim: true },
          example: { type: String, trim: true, default: '' },
        },
      ],
      default: [],
    },
    // Vínculo con Meta
    metaTemplateId: { type: String, trim: true, default: '' },
    rejectionReason: { type: String, trim: true, default: '' },
    syncedAt: { type: Date, default: null },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

messageTemplateSchema.index({ clinic: 1, channel: 1, name: 1 }, { unique: true });

module.exports = mongoose.model('MessageTemplate', messageTemplateSchema);
