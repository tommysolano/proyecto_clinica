/**
 * Salud del canal de WhatsApp: calidad del número (Verde/Amarillo/Rojo) y
 * límite de mensajería diaria. Si la calidad cae, Meta restringe cuántos
 * mensajes puede enviar el número — por eso se alerta al instante.
 *
 * Dos fuentes:
 *  - Webhook `phone_number_quality_update` (tiempo real): eventos FLAGGED
 *    (calidad en rojo), UNFLAGGED (recuperada), DOWNGRADE/UPGRADE (cambio de
 *    límite de mensajería, viene en current_limit).
 *  - Consulta bajo demanda a la Graph API (`fields=quality_rating`) desde el
 *    botón "Actualizar calidad" de la pantalla de números.
 */
const WhatsappAccount = require('../models/WhatsappAccount');

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';

async function raiseQualityAlert(clinicId, { severity, title, body, meta }) {
  const Notification = require('../models/Notification');
  const { emitToClinic } = require('../realtime');
  const notif = await Notification.create({
    clinic: clinicId,
    type: 'whatsapp_quality_changed',
    severity,
    title,
    body,
    meta,
  });
  try {
    emitToClinic(clinicId, 'notification:new', notif);
  } catch {
    /* realtime opcional */
  }
  return notif;
}

/** Busca el número afectado: por display_phone_number del webhook (solo dígitos). */
async function findAccountByDisplayPhone(displayPhone) {
  const digits = String(displayPhone || '').replace(/[^\d]/g, '');
  if (!digits) return null;
  const accounts = await WhatsappAccount.find({ connectionType: 'cloud_api' });
  return (
    accounts.find((a) => String(a.displayPhone || '').replace(/[^\d]/g, '') === digits) ||
    accounts.find((a) => String(a.connectedPhone || '').replace(/[^\d]/g, '') === digits) ||
    null
  );
}

/**
 * Procesa el webhook `phone_number_quality_update` de Meta.
 * value: { display_phone_number, event: 'FLAGGED'|'UNFLAGGED'|'DOWNGRADE'|'UPGRADE'|'ONBOARDING', current_limit }
 * Devuelve true si aplicó algún cambio.
 */
async function handleQualityWebhook(clinicId, value = {}) {
  const account = await findAccountByDisplayPhone(value.display_phone_number);
  if (!account) return false;

  const event = String(value.event || '').toUpperCase();
  const prevRating = account.qualityRating;
  const prevLimit = account.messagingLimit;

  if (event === 'FLAGGED') account.qualityRating = 'RED';
  else if (event === 'UNFLAGGED') account.qualityRating = 'GREEN';
  if (value.current_limit) account.messagingLimit = String(value.current_limit);
  account.qualityUpdatedAt = new Date();
  await account.save();

  if (event === 'FLAGGED' && prevRating !== 'RED') {
    await raiseQualityAlert(clinicId, {
      severity: 'error',
      title: `⚠️ Calidad del número "${account.label}" en ROJO`,
      body:
        'Meta marcó el número por reportes de spam o bloqueos de usuarios. Si no mejora, limitará o suspenderá el envío. Revisa la frecuencia y el contenido de tus plantillas.',
      meta: { account: String(account._id), event, from: prevRating, to: 'RED' },
    });
    return true;
  }
  if (event === 'UNFLAGGED' && prevRating === 'RED') {
    await raiseQualityAlert(clinicId, {
      severity: 'info',
      title: `Calidad del número "${account.label}" recuperada`,
      body: 'Meta quitó la marca de baja calidad del número.',
      meta: { account: String(account._id), event, from: prevRating, to: 'GREEN' },
    });
    return true;
  }
  if ((event === 'DOWNGRADE' || event === 'UPGRADE') && value.current_limit && value.current_limit !== prevLimit) {
    await raiseQualityAlert(clinicId, {
      severity: event === 'DOWNGRADE' ? 'warning' : 'info',
      title:
        event === 'DOWNGRADE'
          ? `El límite de mensajes de "${account.label}" BAJÓ a ${value.current_limit}`
          : `El límite de mensajes de "${account.label}" subió a ${value.current_limit}`,
      body:
        event === 'DOWNGRADE'
          ? 'Meta redujo cuántas conversaciones puede iniciar este número por día (usualmente por baja calidad).'
          : 'Meta amplió cuántas conversaciones puede iniciar este número por día.',
      meta: { account: String(account._id), event, from: prevLimit, to: value.current_limit },
    });
    return true;
  }
  return false;
}

/**
 * Consulta la calidad actual del número a la Graph API y la persiste.
 * Devuelve { ok, qualityRating, messagingLimit } o { ok:false, error }.
 */
async function refreshAccountQuality(account) {
  if (!account || account.connectionType !== 'cloud_api' || !account.phoneNumberId || !account.accessToken) {
    return { ok: false, error: 'El número no es Cloud API o no tiene credenciales' };
  }
  const { decryptSecret } = require('./secretCrypto');
  const accessToken = decryptSecret(account.accessToken);
  const base = `https://graph.facebook.com/${API_VERSION}/${account.phoneNumberId}`;
  try {
    let r = await fetch(`${base}?fields=quality_rating,display_phone_number,messaging_limit_tier`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    let data = await r.json().catch(() => ({}));
    if (!r.ok) {
      // messaging_limit_tier no existe en todas las versiones/permisos: reintenta
      // solo con quality_rating antes de darlo por fallido.
      r = await fetch(`${base}?fields=quality_rating,display_phone_number`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      data = await r.json().catch(() => ({}));
      if (!r.ok) return { ok: false, error: data?.error?.message || `HTTP ${r.status}` };
    }
    const rating = String(data.quality_rating || '').toUpperCase();
    if (['GREEN', 'YELLOW', 'RED'].includes(rating)) account.qualityRating = rating;
    else if (rating) account.qualityRating = 'UNKNOWN';
    if (data.messaging_limit_tier) account.messagingLimit = String(data.messaging_limit_tier);
    account.qualityUpdatedAt = new Date();
    await account.save();
    return { ok: true, qualityRating: account.qualityRating, messagingLimit: account.messagingLimit };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { handleQualityWebhook, refreshAccountQuality, findAccountByDisplayPhone };
