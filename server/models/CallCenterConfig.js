const mongoose = require('mongoose');

/**
 * Configuración por clínica para integraciones de mensajería externa.
 * Una sola documento por clínica. Cada canal puede activarse o no.
 *
 * Importante: los tokens/secrets son sensibles. Aunque no encriptamos en BD,
 * se devuelven enmascarados al cliente (lastN chars) — el cliente solo
 * envía los campos que cambia.
 */
const whatsappSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    // WhatsApp Business Cloud API (Meta)
    phoneNumberId: { type: String, trim: true, default: '' }, // PHONE_NUMBER_ID
    businessAccountId: { type: String, trim: true, default: '' }, // WABA ID
    accessToken: { type: String, default: '' }, // long-lived access token
    verifyToken: { type: String, default: '' }, // para validar webhook GET
    appSecret: { type: String, default: '' }, // para validar firma X-Hub-Signature-256
    displayPhone: { type: String, trim: true, default: '' }, // número visible al agente
  },
  { _id: false }
);

const messengerSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    pageId: { type: String, trim: true, default: '' },
    pageAccessToken: { type: String, default: '' },
    verifyToken: { type: String, default: '' },
    appSecret: { type: String, default: '' },
  },
  { _id: false }
);

const instagramSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    // En Meta, IG Messaging usa el mismo Page Access Token de la página de FB vinculada
    igBusinessAccountId: { type: String, trim: true, default: '' },
    pageId: { type: String, trim: true, default: '' },
    pageAccessToken: { type: String, default: '' },
    verifyToken: { type: String, default: '' },
    appSecret: { type: String, default: '' },
  },
  { _id: false }
);

const tiktokSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    // TikTok Business Messaging — actualmente vía Customer Service API
    appId: { type: String, trim: true, default: '' },
    appSecret: { type: String, default: '' },
    accessToken: { type: String, default: '' },
    businessId: { type: String, trim: true, default: '' },
    verifyToken: { type: String, default: '' },
  },
  { _id: false }
);

const emailSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    provider: { type: String, enum: ['resend'], default: 'resend' },
    apiKey: { type: String, default: '' },
    fromEmail: { type: String, trim: true, default: '' },
    fromName: { type: String, trim: true, default: '' },
    replyTo: { type: String, trim: true, default: '' },
  },
  { _id: false }
);

// Reputación: a dónde enviar a reseñar y a partir de qué rating se considera
// "promotor" (se le pide reseña pública); por debajo, se captura feedback interno.
const reputationSchema = new mongoose.Schema(
  {
    googleReviewUrl: { type: String, trim: true, default: '' },
    minRating: { type: Number, default: 4, min: 1, max: 5 },
  },
  { _id: false }
);

const callCenterConfigSchema = new mongoose.Schema(
  {
    clinic: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Clinic',
      required: true,
      unique: true,
      index: true,
    },
    whatsapp: { type: whatsappSchema, default: () => ({}) },
    messenger: { type: messengerSchema, default: () => ({}) },
    instagram: { type: instagramSchema, default: () => ({}) },
    tiktok: { type: tiktokSchema, default: () => ({}) },
    email: { type: emailSchema, default: () => ({}) },
    reputation: { type: reputationSchema, default: () => ({}) },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CallCenterConfig', callCenterConfigSchema);
