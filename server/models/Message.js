const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
      index: true,
    },
    direction: { type: String, enum: ['in', 'out'], required: true },
    body: { type: String, trim: true },
    mediaUrl: { type: String, trim: true },
    mediaType: { type: String, enum: ['image', 'audio', 'video', 'document', null], default: null },
    // Identificadores externos (WhatsApp message id)
    externalId: { type: String, index: true },
    // Respuesta interactiva (botón o lista de WhatsApp): id + título del elemento
    // elegido. El id permite etiquetar interés (CRO) sin depender del texto visible.
    interactiveReply: {
      id: { type: String, trim: true, default: '' },
      title: { type: String, trim: true, default: '' },
      type: { type: String, enum: ['button_reply', 'list_reply', ''], default: '' },
    },
    templateName: { type: String, trim: true, default: '' },
    errorCode: { type: String, trim: true, default: '' },
    errorMessage: { type: String, trim: true, default: '' },
    statusTimestamps: {
      sentAt: { type: Date },
      deliveredAt: { type: Date },
      readAt: { type: Date },
      failedAt: { type: Date },
    },
    mediaStorageKey: { type: String, trim: true, default: '' },
    // Estado: enviado, entregado, leído (para mensajes salientes)
    deliveryStatus: {
      type: String,
      enum: ['queued', 'sent', 'delivered', 'read', 'failed'],
      default: 'sent',
    },
    sentBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    sentByName: { type: String, trim: true },
    isAutoReply: { type: Boolean, default: false },
    isRead: { type: Boolean, default: false },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
