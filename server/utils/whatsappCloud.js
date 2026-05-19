/**
 * Cliente liviano para WhatsApp Cloud API (Meta).
 *
 * Variables de entorno requeridas:
 *   WHATSAPP_TOKEN             - access token permanente del sistema
 *   WHATSAPP_PHONE_NUMBER_ID   - id del número de teléfono emisor
 *   WHATSAPP_API_VERSION       - opcional (default v20.0)
 *
 * Si las credenciales no están configuradas, las funciones devuelven
 * { ok: false, simulated: true } sin lanzar, para no romper la UX.
 */

const API_VERSION = process.env.WHATSAPP_API_VERSION || 'v20.0';

function isConfigured() {
  return Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID);
}

function normalizePhone(raw) {
  if (!raw) return null;
  return String(raw).replace(/[^\d]/g, '');
}

async function postToMeta(payload) {
  if (!isConfigured()) {
    return { ok: false, simulated: true, reason: 'WhatsApp Cloud no configurado' };
  }
  const url = `https://graph.facebook.com/${API_VERSION}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`,
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
async function sendText(to, body) {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  return postToMeta({
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    text: { body: String(body || '').slice(0, 4096) },
  });
}

/**
 * Envía una plantilla aprobada (requerido para iniciar conversación fuera de la ventana de 24h).
 * @param {string} to - número con código país
 * @param {string} templateName - nombre de la plantilla aprobada
 * @param {string} lang - código de idioma (es, es_ES, etc.)
 * @param {Array} components - parámetros de la plantilla
 */
async function sendTemplate(to, templateName, lang = 'es', components = []) {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  return postToMeta({
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
async function sendBulk(recipients, builderFn) {
  const results = [];
  for (const r of recipients) {
    const payload = typeof builderFn === 'function' ? builderFn(r) : { to: r.phone, body: builderFn };
    const res = payload.template
      ? await sendTemplate(payload.to, payload.template, payload.lang, payload.components)
      : await sendText(payload.to, payload.body);
    results.push({ to: payload.to, ...res, recipient: r });
  }
  return results;
}

module.exports = { isConfigured, sendText, sendTemplate, sendBulk };
