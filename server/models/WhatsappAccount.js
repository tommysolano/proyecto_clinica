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

    // ── Identidad ESTABLE del número (ver utils/whatsappIdentity.js) ──
    // La identidad de un número es SU TELÉFONO, no el `_id` de este documento:
    // borrar el número y volver a crearlo dejaba 4.585 chats apuntando a un id
    // inexistente, respondiéndose por el número por defecto (Meta 131047).
    phoneKey: { type: String, trim: true, default: '', index: true }, // solo dígitos
    previousPhoneKeys: { type: [String], default: [] }, // teléfonos anteriores de esta conexión
    // Ids de documentos ANTERIORES de este MISMO número (borrado y vuelto a
    // crear) cuyo historial absorbió esta cuenta. La resolución del número de
    // salida y la ventana de 24h los tratan como si fueran este mismo id.
    previousIds: { type: [mongoose.Schema.Types.ObjectId], default: [], index: true },
    // Borrado LÓGICO. Un número borrado se archiva en vez de desaparecer: así
    // ningún chat queda apuntando a la nada mientras se reconecta el número.
    archivedAt: { type: Date, default: null, index: true },

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
      // 'syncing' = QR ya escaneado, WhatsApp está sincronizando la sesión.
      enum: ['disconnected', 'qr_pending', 'connecting', 'syncing', 'connected', 'auth_failure'],
      default: 'disconnected',
    },
    sessionId: { type: String, trim: true, default: '' }, // clave del store de sesión (RemoteAuth)
    lastConnectedAt: { type: Date, default: null },
    lastQrAt: { type: Date, default: null },
    // Fecha del ÚLTIMO mensaje ENTRANTE que este número llegó a guardar. No es un
    // dato cosmético: es la referencia con la que el chequeo de salud compara lo
    // que WhatsApp Web tiene en memoria para detectar una sesión ZOMBI (figura
    // conectada, `getState()` dice CONNECTED y los envíos salen, pero los mensajes
    // entrantes ya no llegan al sistema). Ver whatsappQrManager.verifyIngest.
    lastInboundAt: { type: Date, default: null },
    // Rastro de la ÚLTIMA caída: sin esto, "se desconectó otra vez" era una caja
    // negra (no quedaba en ningún sitio por qué se cayó ni cuándo).
    lastDisconnectAt: { type: Date, default: null },
    lastDisconnectReason: { type: String, trim: true, default: '' },
    // `true` solo si hace falta escanear un QR NUEVO (logout o desvinculación
    // desde el teléfono). Con `false`, el servidor reconecta la sesión él solo;
    // con `true` no lo intenta, porque sin QR es imposible.
    lastDisconnectNeedsQr: { type: Boolean, default: false },

    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);

// Para enrutar webhooks Cloud API por phone_number_id de forma rápida.
whatsappAccountSchema.index({ phoneNumberId: 1 });

module.exports = mongoose.model('WhatsappAccount', whatsappAccountSchema);
