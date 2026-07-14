/**
 * Cliente liviano para WhatsApp Cloud API (Meta).
 *
 * Las funciones reciben un objeto `creds` ({ accessToken, phoneNumberId, apiVersion })
 * construido por whatsappGateway a partir de una WhatsappAccount (número global del
 * call center). NO leen credenciales por clínica ni del entorno.
 *
 * Flujo típico (vía gateway):
 *   const creds = gateway.cloudCreds(account);
 *   if (gateway.isCloud(account)) await wa.sendText(creds, to, 'hola');
 *
 * Si las credenciales no están configuradas, las funciones devuelven
 * { ok: false, simulated: true } sin lanzar, para no romper la UX.
 */

// v20.0 salió de soporte (mediados de 2026): fijar una versión vigente evita
// comportamientos raros con los tokens nuevos de integración de negocio.
const DEFAULT_API_VERSION = process.env.WHATSAPP_API_VERSION || 'v23.0';

/**
 * Descarga un media entrante de WhatsApp (imagen/audio/documento) por su id.
 * Devuelve { ok, dataUrl, mimeType } o { ok:false }. Cap de tamaño para no
 * desbordar el documento de Mongo (la media se guarda como dataUrl base64).
 */
async function downloadMedia(creds, mediaId, { maxBytes = 4 * 1024 * 1024 } = {}) {
  if (!isConfigured(creds) || !mediaId) return { ok: false };
  const apiVersion = creds.apiVersion || DEFAULT_API_VERSION;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta.url) return { ok: false };
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
    if (!binRes.ok) return { ok: false };
    const buf = Buffer.from(await binRes.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, tooLarge: true, mimeType: meta.mime_type };
    const mimeType = meta.mime_type || 'application/octet-stream';
    return { ok: true, dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`, mimeType };
  } catch {
    return { ok: false };
  }
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

module.exports = { DEFAULT_API_VERSION, isConfigured, sendText, sendTemplate, sendBulk, downloadMedia };
