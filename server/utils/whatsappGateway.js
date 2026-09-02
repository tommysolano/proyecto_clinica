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
    (await WhatsappAccount.findOne({ enabled: true, isDefault: true, archivedAt: null })) ||
    (await WhatsappAccount.findOne({ enabled: true, archivedAt: null }).sort({ createdAt: 1 }))
  );
}

async function getAccountById(id) {
  if (!id) return null;
  return WhatsappAccount.findById(id);
}

/**
 * El número que hoy ES ese id: el propio documento o, si se borró y el mismo
 * teléfono se volvió a conectar en otro, el que heredó su historial. Esto es lo
 * que impide que un chat de un número reconectado acabe respondiéndose por el
 * número por defecto (ver utils/whatsappIdentity.js).
 */
async function getUsableAccount(id) {
  if (!id) return null;
  const acc = await WhatsappAccount.findById(id);
  if (acc && acc.enabled && !acc.archivedAt) return acc;
  return require('./whatsappIdentity').findSuccessorAccount(id);
}

/** Números conectados, el principal primero. */
async function listEnabledAccounts() {
  return WhatsappAccount.find({ enabled: true, archivedAt: null }).sort({ isDefault: -1, createdAt: 1 });
}

/**
 * ¿ESTE NÚMERO PUEDE ENVIAR AHORA MISMO?
 *
 * POR QUÉ EXISTE (02-sep-2026). WhatsApp BLOQUEÓ «Recepcion 2», el número QR por
 * el que había entrado la mayor parte de la bandeja. Un número bloqueado no se
 * puede reconectar: se queda pidiendo un QR que nunca va a validar. Hasta ahora
 * la resolución del número de salida solo miraba `enabled`/`archivedAt`, así que
 * seguía eligiéndolo y TODAS las respuestas de esos chats morían con
 * "El número QR no está conectado". La bandeja entera se quedaba muda.
 *
 * QUÉ SE CONSIDERA "NO PUEDE ENVIAR" — solo lo que es definitivo sin intervención:
 *   - deshabilitado o archivado (lápida de un número borrado);
 *   - Cloud API sin credenciales (falta el token o el phoneNumberId);
 *   - QR esperando que alguien escanee un QR nuevo: `qr_pending`, `auth_failure`,
 *     o `lastDisconnectNeedsQr` (cerró sesión / lo desvincularon del teléfono).
 *
 * QUÉ **NO** cuenta como muerto, a propósito: 'disconnected', 'connecting' y
 * 'syncing'. Esos son estados de una sesión que está volviendo sola, y el estado
 * guardado se queda pegado con frecuencia — el envío por QR ya pregunta el estado
 * REAL antes de rendirse (`acquireSendableEntry`) y cura la etiqueta. Tratarlos
 * como muertos desviaría al número por defecto envíos que sí iban a salir, y con
 * ellos la ventana de 24h del contacto.
 */
function isSendableAccount(account) {
  return !unsendableReason(account);
}

/** Por qué NO puede enviar este número ('' si sí puede). Texto corto, para la UI. */
function unsendableReason(account) {
  if (!account) return 'missing';
  if (!account.enabled) return 'disabled';
  if (account.archivedAt) return 'archived';
  if (account.connectionType === 'cloud_api') {
    return account.phoneNumberId && account.accessToken ? '' : 'no_credentials';
  }
  if (account.lastDisconnectNeedsQr) return 'needs_qr';
  return ['qr_pending', 'auth_failure'].includes(account.status) ? 'needs_qr' : '';
}

/**
 * Número por defecto QUE DE VERDAD PUEDE ENVIAR. Si el marcado `isDefault` está
 * caído, se usa el siguiente conectado en vez de devolver un número muerto (que
 * es lo que convierte "no salió" en "no salió y no se sabe por qué").
 */
async function getSendableDefaultAccount() {
  const accounts = await listEnabledAccounts();
  return accounts.find(isSendableAccount) || null;
}

/**
 * El número PREFERIDO de una conversación: aquel al que el contacto escribió.
 * Prioridad:
 *   1) El número ENLAZADO a la conversación (el que la ingesta guardó al recibir,
 *      o el que el agente fijó a mano).
 *   2) Si no hay (conversación vieja, o el enlace se perdió): el número por el que
 *      ENTRÓ el ÚLTIMO mensaje del contacto.
 *   3) El rodeo por `Message` para los chats anteriores a `lastInboundAccount`.
 * Devuelve null si no se sabe.
 */
async function preferredAccountForConversation(conv) {
  if (conv && conv.whatsappAccount) {
    // `getUsableAccount` (y no `getAccountById`) para que un chat enlazado a un
    // número que se borró y se volvió a conectar siga saliendo por SU número.
    const acc = await getUsableAccount(conv.whatsappAccount);
    if (acc) return acc;
  }
  // Número por el que entró el ÚLTIMO mensaje, ya anotado en la conversación: es
  // lo mismo que busca el rodeo por `Message` de abajo, pero sin consulta.
  if (conv && conv.lastInboundAccount) {
    const acc = await getUsableAccount(conv.lastInboundAccount);
    if (acc) return acc;
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
        const acc = await getUsableAccount(lastIn.whatsappAccount);
        if (acc) return acc;
      }
    } catch {
      /* sin acceso a mensajes: no se sabe por dónde entró */
    }
  }
  return null;
}

/**
 * Cuenta por la que responder una conversación: el número al que el contacto
 * escribió (ver `preferredAccountForConversation`) y, si ese número NO PUEDE
 * ENVIAR —bloqueado por WhatsApp, sin credenciales, esperando un QR nuevo—, el
 * número por defecto, para que el chat no se quede sin salida.
 *
 * Todo esto es lo que permite responder desde el mismo número al que cada contacto
 * escribe, teniendo varios números conectados a la vez (QR y/o Cloud API).
 *
 * DOS CUIDADOS IMPORTANTES:
 *  - la AUTO-CURA (`conv.whatsappAccount = acc._id`) solo se hace con el número
 *    preferido. El desvío al número por defecto NO se graba: si se grabara, se
 *    perdería para siempre el rastro de a qué número escribió el contacto, y con
 *    él la única forma de devolverle el chat a su número cuando se recupere.
 *  - la ventana de 24h la calcula quien llama CON LA CUENTA QUE ESTA DEVUELVE, así
 *    que un desvío se ve solo en la UI como "escribió a otro de tus números"
 *    (ver messaging.inboundCameFromAnotherNumber): el agente no puede mandar
 *    texto libre por un número que el contacto no conoce, y se le dice por qué.
 */
async function resolveAccountForConversation(conv) {
  const preferred = await preferredAccountForConversation(conv);
  if (preferred && isSendableAccount(preferred)) {
    if (conv && typeof conv.whatsappAccount !== 'undefined') conv.whatsappAccount = preferred._id;
    return preferred;
  }
  // CHATS DE «NÚMERO OCULTO» (@lid). Ver `destinationIsLid`.
  if (destinationIsLid(conv)) {
    // Si se sabe de qué número es el chat, se responde por él aunque esté caído:
    // el error real («el número QR no está conectado») es mejor que un desvío que
    // mandaría la conversación del paciente a un teléfono ajeno.
    if (preferred) return preferred;
    // Sin número conocido (chat recién nacido, todavía sin enlace) se elige el
    // primer QR conectado, NUNCA una cuenta de Cloud API: por Cloud el envío iría
    // a `conv.phone`, que aquí son los dígitos del LID y no un teléfono.
    return (await listEnabledAccounts()).find((a) => a.connectionType === 'qr' && isSendableAccount(a)) || null;
  }
  const fallback = await getSendableDefaultAccount();
  // `preferred` como último recurso: si NINGÚN número puede enviar, es mejor
  // intentarlo por el del chat y devolver el error real del proveedor que
  // desviarlo a otro número que tampoco va a poder.
  return fallback || preferred || getDefaultAccount();
}

/**
 * ¿La única dirección de este chat es un LID (el "número oculto" de WhatsApp)?
 *
 * UN LID NO ES UN TELÉFONO. Cuando un contacto escribe con el número oculto, la
 * sesión QR entrega un identificador tipo `128374619283746@lid` y el chat guarda
 * ESOS DÍGITOS en `phone` mientras no se resuelva el teléfono real. Un LID solo
 * tiene sentido DENTRO de la sesión de WhatsApp Web que lo recibió.
 *
 * Por eso estos chats NO se desvían a otro número aunque el suyo esté bloqueado:
 *  · por Cloud API el envío va a `conv.phone` (messaging.sendToProvider), o sea a
 *    los dígitos del LID — un número que no existe o, mucho peor, el de OTRA
 *    persona a la que le llegaría la conversación de un paciente;
 *  · por otro número QR tampoco, porque ese LID no está en su sesión.
 *
 * Se devuelve el número del chat y el envío falla con el error real («el número
 * QR no está conectado»), que es la verdad y no manda nada a un desconocido.
 */
function destinationIsLid(conv) {
  const ext = String(conv?.externalUserId || '');
  if (!ext.endsWith('@lid')) return false;
  const lid = ext.split('@')[0].replace(/\D/g, '');
  if (!lid) return false;
  return String(conv?.phone || '').replace(/\D/g, '') === lid;
}

/** Busca la cuenta Cloud API destino de un webhook por su phone_number_id. */
async function getCloudAccountByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return WhatsappAccount.findOne({
    connectionType: 'cloud_api',
    phoneNumberId: String(phoneNumberId),
    archivedAt: null,
  });
}

/**
 * Cuenta Cloud API por defecto (para sincronizar/registrar plantillas en su WABA).
 * Prefiere una cuenta COMPLETA (con token y WABA ID): si el número por defecto es
 * QR o a la cuenta elegida le faltan credenciales, otra cuenta Cloud completa
 * sirve igual. Si ninguna está completa devuelve la primera para que el caller
 * pueda reportar exactamente qué campo falta.
 */
async function getDefaultCloudAccount() {
  const clouds = await WhatsappAccount.find({ connectionType: 'cloud_api', enabled: true, archivedAt: null }).sort({
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

async function sendButtons(account, to, body, buttons, contextMessageId, quoteBody) {
  if (!account) return { ok: false, errorCode: 'provider_unavailable', error: 'Sin número de WhatsApp configurado' };
  if (account.connectionType === 'qr') {
    // WhatsApp Web ya no ofrece una API estable para botones interactivos. El
    // caller entrega una versión textual equivalente para que la respuesta siga
    // pudiendo asociarse por su título.
    return require('./whatsappQrManager').sendText(account, to, body, contextMessageId, quoteBody);
  }
  return cloudTokenError(account) || wa.sendButtons(cloudCreds(account), to, body, buttons, contextMessageId);
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
  getUsableAccount,
  getSendableDefaultAccount,
  isSendableAccount,
  destinationIsLid,
  unsendableReason,
  listEnabledAccounts,
  preferredAccountForConversation,
  resolveAccountForConversation,
  getCloudAccountByPhoneNumberId,
  getDefaultCloudAccount,
  cloudCreds,
  cloudTokenError,
  isCloud,
  sendText,
  sendButtons,
  sendMedia,
  sendTemplate,
  downloadMedia,
};
