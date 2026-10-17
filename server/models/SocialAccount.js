const mongoose = require('mongoose');

/**
 * Cuenta de red social conectada para PUBLICAR (no para chatear: los canales de
 * mensajería siguen en CallCenterConfig).
 *
 * Es del CRM, que es ÚNICO para todas las empresas: vive bajo la clínica ancla
 * (middleware/callCenterScope) y la usan todos, sin importar la empresa activa.
 *
 * Una fila por destino donde se publica:
 *   - facebook  → una Página (externalId = page id, token de página)
 *   - instagram → una cuenta profesional (externalId = IG user id). Publica con
 *                 el token de la Página a la que está vinculada (pageId).
 *   - tiktok    → un creador (externalId = open_id). Token de 24 h + refresh.
 *   - youtube   → un canal (externalId = channel id). Token de 1 h + refresh.
 *
 * Los tokens se guardan cifrados (utils/secretCrypto) y NUNCA salen al cliente:
 * usar `toPublic()` en las respuestas.
 */
const socialAccountSchema = new mongoose.Schema(
  {
    clinic: { type: mongoose.Schema.Types.ObjectId, ref: 'Clinic', required: true, index: true },
    network: { type: String, enum: ['facebook', 'instagram', 'tiktok', 'youtube'], required: true },
    externalId: { type: String, required: true, trim: true },
    name: { type: String, trim: true, default: '' },
    username: { type: String, trim: true, default: '' },
    avatarUrl: { type: String, trim: true, default: '' },
    // Instagram: la Página de Facebook vinculada (su token es el que publica).
    pageId: { type: String, trim: true, default: '' },
    accessToken: { type: String, default: '' },
    refreshToken: { type: String, default: '' },
    tokenExpiresAt: { type: Date, default: null },
    refreshExpiresAt: { type: Date, default: null },
    scopes: { type: [String], default: [] },
    status: { type: String, enum: ['connected', 'error'], default: 'connected' },
    lastError: { type: String, trim: true, default: '' },
    lastCheckedAt: { type: Date, default: null },
    connectedVia: { type: String, enum: ['oauth', 'token'], default: 'oauth' },
    connectedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true }
);

socialAccountSchema.index({ clinic: 1, network: 1, externalId: 1 }, { unique: true });

socialAccountSchema.methods.toPublic = function toPublic() {
  return {
    _id: this._id,
    network: this.network,
    externalId: this.externalId,
    name: this.name,
    username: this.username,
    avatarUrl: this.avatarUrl,
    pageId: this.pageId,
    status: this.status,
    lastError: this.lastError,
    lastCheckedAt: this.lastCheckedAt,
    tokenExpiresAt: this.tokenExpiresAt,
    refreshExpiresAt: this.refreshExpiresAt,
    scopes: this.scopes,
    connectedVia: this.connectedVia,
    createdAt: this.createdAt,
  };
};

module.exports = mongoose.model('SocialAccount', socialAccountSchema);
