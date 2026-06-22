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
const { decryptSecret } = require('./secretCrypto');

const DEFAULT_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

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

/** Cuenta por la que responder una conversación: la suya si está activa, o la por defecto. */
async function resolveAccountForConversation(conv) {
  if (conv && conv.whatsappAccount) {
    const acc = await getAccountById(conv.whatsappAccount);
    if (acc && acc.enabled) return acc;
  }
  return getDefaultAccount();
}

/** Busca la cuenta Cloud API destino de un webhook por su phone_number_id. */
async function getCloudAccountByPhoneNumberId(phoneNumberId) {
  if (!phoneNumberId) return null;
  return WhatsappAccount.findOne({ connectionType: 'cloud_api', phoneNumberId: String(phoneNumberId) });
}

/** Cuenta Cloud API por defecto (para sincronizar plantillas con su WABA). */
async function getDefaultCloudAccount() {
  return (
    (await WhatsappAccount.findOne({ connectionType: 'cloud_api', enabled: true, isDefault: true })) ||
    (await WhatsappAccount.findOne({ connectionType: 'cloud_api', enabled: true }).sort({ createdAt: 1 }))
  );
}

function cloudCreds(account) {
  return {
    accessToken: decryptSecret(account.accessToken),
    phoneNumberId: account.phoneNumberId,
    apiVersion: DEFAULT_API_VERSION,
  };
}

function isCloud(account) {
  return account && account.connectionType === 'cloud_api';
}

// ── Envío (enruta por método) ──

async function sendText(account, to, body) {
  if (!account) return { ok: false, errorCode: 'provider_unavailable', error: 'Sin número de WhatsApp configurado' };
  if (account.connectionType === 'qr') {
    return require('./whatsappQrManager').sendText(account, to, body);
  }
  return wa.sendText(cloudCreds(account), to, body);
}

async function sendTemplate(account, to, templateName, lang, components) {
  if (!account) return { ok: false, errorCode: 'provider_unavailable', error: 'Sin número de WhatsApp configurado' };
  if (account.connectionType === 'qr') {
    // Una sesión QR no admite plantillas de Meta. El caller debe enviar texto libre.
    return { ok: false, errorCode: 'qr_no_template', error: 'El número QR no admite plantillas; usa texto libre.' };
  }
  return wa.sendTemplate(cloudCreds(account), to, templateName, lang, components);
}

async function downloadMedia(account, mediaId, opts) {
  if (!account) return { ok: false };
  if (account.connectionType === 'qr') {
    return require('./whatsappQrManager').downloadMedia(account, mediaId, opts);
  }
  return wa.downloadMedia(cloudCreds(account), mediaId, opts);
}

module.exports = {
  DEFAULT_API_VERSION,
  getDefaultAccount,
  getAccountById,
  resolveAccountForConversation,
  getCloudAccountByPhoneNumberId,
  getDefaultCloudAccount,
  cloudCreds,
  isCloud,
  sendText,
  sendTemplate,
  downloadMedia,
};
