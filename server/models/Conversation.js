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
    // Nombre de la oportunidad ("Botox — Ana Vera"). Es lo que la identifica en el
    // embudo y en los listados; sin él solo se distinguían por "Oportunidad #1,
    // #2…". Si se guarda vacío, el servidor le pone uno por defecto a partir de
    // los servicios de interés y del contacto (defaultOpportunityName).
    name: { type: String, trim: true, default: '' },
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
    // De dónde sale `expectedValue`:
    //  - 'auto'   → suma del precio de venta de los servicios de interés (inventario).
    //  - 'manual' → importe escrito a mano (presupuestos, paquetes, descuentos…),
    //               que el servidor NO recalcula aunque cambien los servicios.
    valueMode: { type: String, enum: ['auto', 'manual'], default: 'auto' },
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
    // Teléfono REAL de un chat de "número oculto" (@lid) cuando `phone` no lo puede
    // guardar porque YA existe otro chat con ese número (p.ej. la persona escribió
    // antes al número de Cloud API y ahora escribe al QR). (clinic, phone) es único,
    // así que sin este campo los dos chats quedaban como dos personas distintas y
    // una campaña dirigida al teléfono no veía nunca la conversación del QR: le
    // respondía por el número por defecto en vez de por el último que usó el
    // contacto. Es el enlace que permite tratarlos como la misma persona.
    linkedPhone: { type: String, trim: true, default: '', index: true },
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
    // Fecha del ÚLTIMO mensaje ENTRANTE (del contacto). Es la fuente de verdad de
    // la ventana de 24h de WhatsApp: sobrevive a los mensajes salientes (cuando un
    // agente responde o envía una cotización, `lastMessageDirection` pasa a 'out'
    // pero la ventana sigue viva 24h desde este momento). Antes, sin este campo,
    // un chat contestado hace minutos aparecía como "ventana cerrada".
    lastInboundAt: { type: Date, default: null },
    // Número (global) por el que llegó ese último entrante. La ventana de 24h de
    // Meta es de la pareja (nuestro número, contacto): que el paciente escriba al
    // WhatsApp de recepción NO abre ventana en el número de la API. Sin este dato
    // la ventana se calculaba a ciegas y el CRM decía "abierta" mientras Meta
    // rechazaba el texto con 131047 (ver `inboundCameFromAnotherNumber`).
    lastInboundAccount: { type: mongoose.Schema.Types.ObjectId, ref: 'WhatsappAccount', default: null },
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
    // Por defecto 'out': una conversación recién creada NO tiene ningún mensaje,
    // así que "el último es del contacto" siempre sería mentira. Con el antiguo
    // default 'in' un chat nacido de un envío nuestro parecía tener un entrante
    // reciente → ventana de 24h fantasma y chats contados como "esperando
    // respuesta". La ingesta de entrantes lo pone en 'in' cuando toca.
    lastMessageDirection: { type: String, enum: ['in', 'out'], default: 'out' },
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
