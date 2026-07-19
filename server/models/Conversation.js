const mongoose = require('mongoose');

/**
 * Una Conversation representa un chat de WhatsApp (o canal similar) con un contacto.
 * - phone: número internacional sin "+" (clave junto a clinic para detectar duplicados).
 * - patient: vinculado cuando el contacto es paciente existente.
 * - assignedTo: agente del call center que está atendiendo el chat.
 * - status: open | closed | archived.
 * - isFeatured: marcado como destacado para seguimiento.
 * - opportunity: cuando el chat se convierte en una oportunidad de venta/cita,
 *   se completa esta sub-estructura. opportunity.stage sigue el flujo Kanban.
 * - lastMessage*: snapshot del último mensaje para listados rápidos.
 * - unreadCount: sube con cada mensaje entrante. NO se limpia al abrir el chat:
 *   el pendiente permanece hasta que un agente RESPONDE (así no se pierde entre
 *   muchas conversaciones). Se pone en 0 al enviar respuesta (ver messaging.send
 *   y chatController.sendGalleryImage).
 */
const opportunitySchema = new mongoose.Schema(
  {
    isOpportunity: { type: Boolean, default: false },
    stage: {
      type: String,
      enum: ['nuevo', 'contactado', 'interesado', 'agendado', 'ganado', 'perdido'],
      default: 'nuevo',
    },
    interestedIn: [
      {
        product: { type: mongoose.Schema.Types.ObjectId, ref: 'Product' },
        name: String,
      },
    ],
    expectedValue: { type: Number, default: 0, min: 0 },
    notes: { type: String, trim: true },
    // Etiquetas propias de la oportunidad (independientes de las del contacto/paciente).
    tags: { type: [String], default: [] },
    appointment: { type: mongoose.Schema.Types.ObjectId, ref: 'Appointment', default: null },
    convertedAt: { type: Date },
    lostReason: { type: String, trim: true },
    // De qué ANUNCIO nació esta oportunidad (click-to-WhatsApp). Permite tener
    // una oportunidad por anuncio dentro del mismo chat.
    attribution: {
      adId: { type: String, trim: true, default: '' },
      campaign: { type: String, trim: true, default: '' },
      ctwaClid: { type: String, trim: true, default: '' },
    },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const conversationSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      index: true,
    },
    // Identificación del contacto
    phone: { type: String, required: true, trim: true, index: true },
    contactName: { type: String, trim: true },
    patient: { type: mongoose.Schema.Types.ObjectId, ref: 'Patient', default: null },
    channel: {
      type: String,
      enum: ['whatsapp', 'sms', 'web', 'messenger', 'instagram', 'tiktok'],
      default: 'whatsapp',
    },
    // Identificador del usuario en el canal externo (ej: PSID de Messenger, IGSID, etc.)
    externalUserId: { type: String, trim: true, default: '' },
    // Número de WhatsApp (global) por el que entró/responde esta conversación.
    // Si está vacío, al responder se usa el número marcado como `isDefault`.
    whatsappAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappAccount', default: null },
    // Asignación
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    assignedToName: { type: String, trim: true },
    assignedAt: { type: Date },
    // Estado
    status: {
      type: String,
      enum: ['open', 'closed', 'archived'],
      default: 'open',
      index: true,
    },
    isFeatured: { type: Boolean, default: false, index: true },
    featuredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    featuredAt: { type: Date },
    featuredNote: { type: String, trim: true },
    // Bloqueo de contacto: no se podrán enviar/recibir mensajes mientras esté bloqueado.
    blocked: { type: Boolean, default: false, index: true },
    blockedAt: { type: Date },
    blockedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    window24hExpiresAt: { type: Date, default: null, index: true },
    attribution: {
      adId: { type: String, trim: true, default: '' },
      campaign: { type: String, trim: true, default: '' },
      ctwaClid: { type: String, trim: true, default: '' },
    },
    internalNotes: {
      type: [
        {
          author: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
          authorName: { type: String, trim: true, default: '' },
          body: { type: String, trim: true },
          mentions: { type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], default: [] },
          at: { type: Date, default: Date.now },
        },
      ],
      default: [],
    },
    firstResponseAt: { type: Date, default: null },
    lastAgentReplyAt: { type: Date, default: null },
    // Oportunidad principal (compatibilidad). El array `opportunities` permite tener varias por chat.
    opportunity: { type: opportunitySchema, default: () => ({}) },
    opportunities: { type: [opportunitySchema], default: [] },
    // Snapshot último mensaje
    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessagePreview: { type: String, trim: true },
    lastMessageDirection: { type: String, enum: ['in', 'out'], default: 'in' },
    unreadCount: { type: Number, default: 0 },
    // Tags libres para segmentar
    tags: { type: [String], default: [] },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

conversationSchema.index({ clinic: 1, phone: 1 }, { unique: true });
conversationSchema.index({ clinic: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
