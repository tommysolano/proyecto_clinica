/**
 * Cliente liviano para WhatsApp Cloud API (Meta).
 *
 * Las credenciales se toman de la configuración por clínica guardada en
 * CallCenterConfig (pantalla /call-center-config), NO de variables de entorno.
 *
 * Flujo típico:
 *   const { ok, creds, reason } = await wa.loadCreds(clinicId);
 *   if (ok) await wa.sendText(creds, to, 'hola');
 *
 * Si las credenciales no están configuradas, las funciones devuelven
 * { ok: false, simulated: true } sin lanzar, para no romper la UX.
 */

const CallCenterConfig = require('../models/CallCenterConfig');

const DEFAULT_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

/**
 * Carga las credenciales de WhatsApp de una clínica desde CallCenterConfig.
 * @param {string|ObjectId} clinicId
 * @returns {{ ok: boolean, creds?: object, reason?: string }}
 */
async function loadCreds(clinicId) {
  if (!clinicId) return { ok: false, reason: 'clinicId requerido' };
  const cfg = await CallCenterConfig.findOne({ clinic: clinicId }).lean();
  const wa = cfg && cfg.whatsapp;
  if (!wa) return { ok: false, reason: 'WhatsApp no configurado para la clínica' };
  if (!wa.enabled) return { ok: false, reason: 'El canal WhatsApp está inactivo' };
  if (!wa.accessToken || !wa.phoneNumberId) {
    return { ok: false, reason: 'Faltan credenciales de WhatsApp (accessToken / phoneNumberId)' };
  }
  return {
    ok: true,
    creds: {
      accessToken: wa.accessToken,
      phoneNumberId: wa.phoneNumberId,
      apiVersion: DEFAULT_API_VERSION,
    },
  };
}

function isConfigured(creds) {
  return Boolean(creds && creds.accessToken && creds.phoneNumberId);
}

function normalizePhone(raw) {
  if (!raw) return null;
  return String(raw).replace(/[^\d]/g, '');
}

async function postToMeta(creds, payload) {
  if (!isConfigured(creds)) {
    return { ok: false, simulated: true, reason: 'WhatsApp Cloud no configurado' };
  }
  const apiVersion = creds.apiVersion || DEFAULT_API_VERSION;
  const url = `https://graph.facebook.com/${apiVersion}/${creds.phoneNumberId}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${creds.accessToken}`,
      },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return { ok: false, status: res.status, error: data?.error?.message || 'WhatsApp API error', data };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Envía un mensaje de texto plano (solo válido en ventana de 24h tras último mensaje del usuario).
 */
async function sendText(creds, to, body) {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  return postToMeta(creds, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: String(body || '').slice(0, 4096) },
  });
}

/**
 * Envía una plantilla aprobada (requerido para iniciar conversación fuera de la ventana de 24h).
 * @param {object} creds - credenciales de la clínica (ver loadCreds)
 * @param {string} to - número con código país
 * @param {string} templateName - nombre de la plantilla aprobada
 * @param {string} lang - código de idioma (es, es_ES, etc.)
 * @param {Array} components - parámetros de la plantilla
 */
async function sendTemplate(creds, to, templateName, lang = 'es', components = []) {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  return postToMeta(creds, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'template',
    template: {
      name: templateName,
      language: { code: lang },
      components,
    },
  });
}

/**
 * Envía mensajes en lote. Devuelve un array de resultados.
 * No paraleliza con altísima concurrencia para no exceder rate limits.
 */
async function sendBulk(creds, recipients, builderFn) {
  const results = [];
  for (const r of recipients) {
    const payload = typeof builderFn === 'function' ? builderFn(r) : { to: r.phone, body: builderFn };
    const res = payload.template
      ? await sendTemplate(creds, payload.to, payload.template, payload.lang, payload.components)
      : await sendText(creds, payload.to, payload.body);
    results.push({ to: payload.to, ...res, recipient: r });
  }
  return results;
}

module.exports = { loadCreds, isConfigured, sendText, sendTemplate, sendBulk };
