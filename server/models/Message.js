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
    // 'sticker' es un webp de WhatsApp: se guarda con su tipo propio para poder
    // pintarlo pequeño y transparente (no como una imagen normal en una burbuja).
    mediaType: { type: String, enum: ['image', 'audio', 'video', 'document', 'sticker', null], default: null },
    // Nombre original del archivo adjunto (documentos): "REPORTE DE PLASMA.xlsx".
    // Permite mostrar la tarjeta de documento igual que WhatsApp en vez de un
    // genérico "Ver adjunto".
    mediaName: { type: String, trim: true, default: '' },
    // Tamaño del adjunto en bytes (si el proveedor lo informa) para la tarjeta.
    mediaSize: { type: Number, default: 0 },
    // Cómo llegó/salió el mensaje. 'phone' marca los enviados desde el teléfono
    // (número QR) fuera de nuestro sistema, para distinguirlos en la burbuja.
    origin: { type: String, enum: ['system', 'phone', ''], default: '' },
    // Número (global) por el que ENTRÓ/salió este mensaje. En los ENTRANTES es el
    // número al que el contacto escribió: sirve para responder por el mismo número
    // aunque la conversación no tenga enlazada la cuenta (auto-cura la ruta).
    whatsappAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappAccount', default: null },
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
    // Anuncio click-to-WhatsApp del que nació ESTE mensaje (solo entrantes, y solo
    // en el primer mensaje tras tocar el anuncio). Snapshot para pintar en el chat
    // "de qué anuncio nos escriben" (headline + link), como en la captura de Daplox.
    referral: {
      sourceId: { type: String, trim: true, default: '' }, // = referral.source_id (Ad ID)
      sourceType: { type: String, trim: true, default: '' }, // ad | post
      sourceUrl: { type: String, trim: true, default: '' }, // enlace fb.me/…
      headline: { type: String, trim: true, default: '' },
      body: { type: String, trim: true, default: '' },
      ctwaClid: { type: String, trim: true, default: '' },
    },
    // Respuesta a un mensaje específico (cita estilo WhatsApp). Snapshot para
    // renderizar la burbuja citada sin populate; `message` apunta al original
    // para poder saltar a él; `externalId` es el wamid que se manda a WhatsApp
    // como `context` para que el contacto también vea la cita.
    replyTo: {
      message: { type: mongoose.Schema.Types.ObjectId, ref: 'Message', default: null },
      externalId: { type: String, trim: true, default: '' },
      direction: { type: String, enum: ['in', 'out', ''], default: '' },
      senderName: { type: String, trim: true, default: '' },
      body: { type: String, trim: true, default: '' },
      mediaType: { type: String, trim: true, default: '' },
    },
    // Resultado REAL de la cita en WhatsApp (solo salientes con replyTo):
    // 'quoted_by_id' | 'quoted_by_text' | 'failed:<motivo>'. Vacío si no aplica.
    // Permite auditar sin acceso a los logs del servidor por qué una respuesta
    // llegó (o no) citada al destinatario.
    quoteResult: { type: String, trim: true, default: '' },
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
