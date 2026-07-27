/**
 * Gateway de WhatsApp: abstrae el MÉTODO de conexión de cada número.
 *
 * Una WhatsappAccount puede ser:
 *   - 'cloud_api' → WhatsApp Business Cloud API (Meta). Reutiliza whatsappCloud.js.
 *   - 'qr'        → sesión tipo WhatsApp Web (whatsapp-web.js). Reutiliza
 *                   whatsappQrManager.js (carga diferida para evitar dependencias
 *                   circulares y no exigir Chromium si no hay números QR).
 *
 * Las funciones de envío reciben una **cuenta** (documento WhatsappAccount) en vez
 * de un clinicId. La resolución de "qué número usar" la hacen resolveAccount* abajo.
 */
const WhatsappAccount = require('../models/WhatsappAccount');
const wa = require('./whatsappCloud');
const { decryptSecret, isEncrypted } = require('./secretCrypto');

// v20.0 salió de soporte (mediados de 2026): mantener una versión vigente.
const DEFAULT_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';

// ── Resolución de cuentas ──

/** Número por defecto para campañas/workflows (el marcado isDefault, o el más antiguo activo). */
async function getDefaultAccount() {
  return (
    (await WhatsappAccount.findOne({ enabled: true, isDefault: true })) ||
    (await WhatsappAccount.findOne({ enabled: true }).sort({ createdAt: 1 }))
  );
}

async function getAccountById(id) {
  if (!id) return null;
  return WhatsappAccount.findById(id);
}

/** Números conectados, el principal primero. */
async function listEnabledAccounts() {
  return WhatsappAccount.find({ enabled: true }).sort({ isDefault: -1, createdAt: 1 });
}

/**
 * Cuenta por la que responder una conversación. Prioridad:
 *   1) El número ENLAZADO a la conversación (el que la ingesta guardó al recibir).
 *   2) Si no hay (conversación vieja, o el enlace se perdió): el número por el que
 *      ENTRÓ el ÚLTIMO mensaje del contacto — así se responde SIEMPRE por el número
 *      al que el cliente escribió, no por el número por defecto. Además AUTO-CURA la
 *      conversación (deja `conv.whatsappAccount` fijado para la próxima vez).
 *   3) Como último recurso, el número por defecto.
 * Todo esto es lo que permite responder desde el mismo número al que cada contacto
 * escribe, teniendo varios números conectados a la vez (QR y/o Cloud API).
 */
async function resolveAccountForConversation(conv) {
  if (conv && conv.whatsappAccount) {
    const acc = await getAccountById(conv.whatsappAccount);
    if (acc && acc.enabled) return acc;
  }
  if (conv && conv._id) {
    try {
      const Message = require('../models/Message');
      const lastIn = await Message.findOne({
        conversation: conv._id,
        direction: 'in',
        whatsappAccount: { $ne: null },
      })
        .sort({ createdAt: -1 })
        .select('whatsappAccount')
        .lean();
      if (lastIn?.whatsappAccount) {
        const acc = await getAccountById(lastIn.whatsappAccount);
        if (acc && acc.enabled) {
          // Auto-cura: enlaza la conversación al número por el que entró el contacto.
          if (typeof conv.whatsappAccount !== 'undefined') conv.whatsappAccount = acc._id;
          return acc;
        }
      }
    } catch {
      /* sin acceso a mensajes: cae al número por defecto */
    }
  }
  return getDefaultAccount();
}

/** Busca la cuenta Cloud API destino de un webhook por su phone_number_id. */
async function getCloudAccountByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return WhatsappAccount.findOne({ connectionType: 'cloud_api', phoneNumberId: String(phoneNumberId) });
}

/**
 * Cuenta Cloud API por defecto (para sincronizar/registrar plantillas en su WABA).
 * Prefiere una cuenta COMPLETA (con token y WABA ID): si el número por defecto es
 * QR o a la cuenta elegida le faltan credenciales, otra cuenta Cloud completa
 * sirve igual. Si ninguna está completa devuelve la primera para que el caller
 * pueda reportar exactamente qué campo falta.
 */
async function getDefaultCloudAccount() {
  const clouds = await WhatsappAccount.find({ connectionType: 'cloud_api', enabled: true }).sort({
    isDefault: -1,
    createdAt: 1,
  });
  if (!clouds.length) return null;
  return clouds.find((a) => a.accessToken && a.businessAccountId) || clouds[0];
}

function cloudCreds(account) {
  return {
    accessToken: decryptSecret(account.accessToken),
    phoneNumberId: account.phoneNumberId,
    apiVersion: DEFAULT_API_VERSION,
  };
}

/**
 * Guardia previa al envío por Cloud API: si el token, tras descifrarlo, SIGUE
 * cifrado (`enc:v1:…`), significa que el servidor no tiene la `SECRETS_KEY` con la
 * que se cifró (falta o cambió). Sin esto se enviaba el blob cifrado a Meta y volvía
 * "Authentication Error / Cannot parse access token" — un error críptico. Aquí se
 * corta con un mensaje ACCIONABLE (vuelve a guardar el token) y no se gasta la llamada.
 */
function cloudTokenError(account) {
  const token = decryptSecret(account.accessToken);
  if (!token || isEncrypted(token)) {
    return {
      ok: false,
      errorCode: 'token_undecryptable',
      error:
        `El token de WhatsApp del número «${account.label || 'Cloud API'}» no se pudo descifrar en el ` +
        'servidor (falta o cambió SECRETS_KEY). Vuelve a guardar el token del número en ' +
        'Configuración → WhatsApp para que quede cifrado con la clave actual.',
    };
  }
  return null;
}

function isCloud(account) {
  return account && account.connectionType === 'cloud_api';
}

// ── Envío (enruta por método) ──

async function sendText(account, to, body, contextMessageId, quoteBody) {
  if (!account) return { ok: false, errorCode: 'provider_unavailable', error: 'Sin número de WhatsApp configurado' };
  if (account.connectionType === 'qr') {
    // quoteBody permite al QR citar por texto si no tenemos el wamid guardado.
    return require('./whatsappQrManager').sendText(account, to, body, contextMessageId, quoteBody);
  }
  return cloudTokenError(account) || wa.sendText(cloudCreds(account), to, body, contextMessageId);
}

/**
 * Envía media (imagen/video/documento/audio) con texto de pie. Por QR la sesión
 * descarga los bytes (de Mongo si es media propia, o de la URL) y los manda como
 * MessageMedia. Por Cloud API la media PROPIA (autoalojada o data URL inline) se
 * SUBE a Meta y se envía por id; solo las URLs externas van por link. `type`
 * importa: un 'audio' se manda como NOTA DE VOZ, no como archivo adjunto.
 */
async function sendMedia(account, to, url, caption, type = 'image', contextMessageId, quoteBody) {
  if (!account) return { ok: false, errorCode: 'provider_unavailable', error: 'Sin número de WhatsApp configurado' };
  if (account.connectionType === 'qr') {
    return require('./whatsappQrManager').sendMedia(account, to, url, caption, type, contextMessageId, quoteBody);
  }
  return cloudTokenError(account) || wa.sendMedia(cloudCreds(account), to, url, caption, type, contextMessageId);
}

async function sendTemplate(account, to, templateName, lang, components) {
  if (!account) return { ok: false, errorCode: 'provider_unavailable', error: 'Sin número de WhatsApp configurado' };
  if (account.connectionType === 'qr') {
    // Una sesión QR no admite plantillas de Meta. El caller debe enviar texto libre.
    return { ok: false, errorCode: 'qr_no_template', error: 'El número QR no admite plantillas; usa texto libre.' };
  }
  return cloudTokenError(account) || wa.sendTemplate(cloudCreds(account), to, templateName, lang, components);
}

async function downloadMedia(account, mediaId, opts) {
  if (!account) return { ok: false, error: 'Sin número de WhatsApp para descargar el archivo' };
  if (account.connectionType === 'qr') {
    return require('./whatsappQrManager').downloadMedia(account, mediaId, opts);
  }
  const tokenErr = cloudTokenError(account);
  if (tokenErr) return { ok: false, error: tokenErr.error };
  return wa.downloadMedia(cloudCreds(account), mediaId, opts);
}

module.exports = {
  DEFAULT_API_VERSION,
  getDefaultAccount,
  getAccountById,
  listEnabledAccounts,
  resolveAccountForConversation,
  getCloudAccountByPhoneNumberId,
  getDefaultCloudAccount,
  cloudCreds,
  cloudTokenError,
  isCloud,
  sendText,
  sendMedia,
  sendTemplate,
  downloadMedia,
};
