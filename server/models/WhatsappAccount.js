const mongoose = require('mongoose');

/**
 * Número de WhatsApp del call center. Es **global** (no pertenece a una clínica):
 * el call center atiende a todas las sedes. Puede haber varios números, y cada uno
 * se conecta por uno de dos métodos:
 *
 *  - 'cloud_api': WhatsApp Business Cloud API (Meta, oficial). Usa phoneNumberId +
 *    accessToken (cifrado). El appSecret/verifyToken del webhook son compartidos y
 *    viven en CallCenterWhatsappConfig (a nivel de app).
 *  - 'qr': sesión tipo WhatsApp Web vía whatsapp-web.js (no oficial). No usa
 *    credenciales de Meta; se vincula escaneando un QR y la sesión se persiste para
 *    reconectar tras reinicios. `status` refleja el estado vivo de esa sesión.
 *
 * El accessToken se cifra en reposo (secretCrypto) y se enmascara al cliente.
 */
const whatsappAccountSchema = new mongoose.Schema(
  {
    label: { type: String, trim: true, required: true }, // nombre amistoso, ej. "Recepción"
    connectionType: { type: String, enum: ['cloud_api', 'qr'], required: true },
    enabled: { type: Boolean, default: true },
    isDefault: { type: Boolean, default: false }, // número usado por campañas/workflows
    displayPhone: { type: String, trim: true, default: '' }, // E.164 visible (ingresado por el usuario)
    connectedPhone: { type: String, trim: true, default: '' }, // el que reporta WhatsApp al vincular por QR

    // ── Cloud API (Meta) ──
    phoneNumberId: { type: String, trim: true, default: '' }, // PHONE_NUMBER_ID (clave para enrutar webhooks)
    businessAccountId: { type: String, trim: true, default: '' }, // WABA ID
    accessToken: { type: String, default: '' }, // cifrado

    // ── Salud del canal (Meta) ── calidad del número y límite de mensajería.
    // Se actualizan por webhook (phone_number_quality_update) o al refrescar por API.
    qualityRating: { type: String, enum: ['GREEN', 'YELLOW', 'RED', 'UNKNOWN'], default: 'UNKNOWN' },
    messagingLimit: { type: String, trim: true, default: '' }, // ej. TIER_1K
    qualityUpdatedAt: { type: Date, default: null },

    // ── QR (whatsapp-web.js) ──
    status: {
      type: String,
      enum: ['disconnected', 'qr_pending', 'connecting', 'connected', 'auth_failure'],
      default: 'disconnected',
    },
    sessionId: { type: String, trim: true, default: '' }, // clave del store de sesión (RemoteAuth)
    lastConnectedAt: { type: Date, default: null },
    lastQrAt: { type: Date, default: null },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Para enrutar webhooks Cloud API por phone_number_id de forma rápida.
whatsappAccountSchema.index({ phoneNumberId: 1 });

module.exports = mongoose.model('WhatsappAccount', whatsappAccountSchema);
