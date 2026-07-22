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
    return { ok: true, dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`, mimeType, size: buf.length };
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
async function sendText(creds, to, body, contextMessageId) {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  return postToMeta(creds, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'text',
    ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    text: { body: String(body || '').slice(0, 4096) },
  });
}

/**
 * Sube los BYTES de una media a Meta (endpoint /media) y devuelve su media id.
 * Enviar la media por id (en vez de por link) evita que Meta tenga que DESCARGAR
 * nuestra URL pública — la causa típica de "media que se marca enviada pero nunca
 * llega": el texto va inline y llega, pero Meta no logra bajar el link de la media
 * (URL no alcanzable, HTTPS, tamaño, timeout). Devuelve { ok, id } o el error de
 * Meta (media muy grande, tipo no soportado, etc.) para marcar el envío fallido.
 */
async function uploadMedia(creds, { buffer, mimeType }) {
  if (!isConfigured(creds)) return { ok: false, simulated: true };
  const apiVersion = creds.apiVersion || DEFAULT_API_VERSION;
  const mime = mimeType || 'application/octet-stream';
  const ext = (mime.split('/')[1] || 'bin').split(';')[0].replace('jpeg', 'jpg');
  try {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mime);
    form.append('file', new Blob([buffer], { type: mime }), `archivo.${ext}`);
    const res = await fetch(`https://graph.facebook.com/${apiVersion}/${creds.phoneNumberId}/media`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${creds.accessToken}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      return { ok: false, status: res.status, error: data?.error?.message || `No se pudo subir la media a WhatsApp (HTTP ${res.status})`, data };
    }
    return { ok: true, id: data.id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Envía media (imagen/video/documento/audio) con texto de pie. Si la URL es
 * autoalojada (/api/public/media/:id) se SUBEN los bytes a Meta y se envía por id
 * (más fiable que por link, ver uploadMedia). Para URLs externas se manda el link
 * (Meta las descarga; no admite data URLs). Audio: ogg/opus, mpeg, mp4, aac o amr.
 */
async function sendMedia(creds, to, url, caption, type = 'image', contextMessageId) {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  if (!isConfigured(creds)) return { ok: false, simulated: true, reason: 'WhatsApp Cloud no configurado' };
  const kind = ['image', 'video', 'document', 'audio'].includes(type) ? type : 'image';

  let media = null;
  // Media autoalojada: subir los bytes a Meta y enviar por id (no por link).
  const selfHosted = String(url || '').match(/\/api\/public\/media\/([a-f0-9]{24})/i);
  if (selfHosted) {
    const img = await require('../models/ChatGalleryImage')
      .findById(selfHosted[1])
      .select('dataUrl mimeType')
      .lean()
      .catch(() => null);
    const parsed = img?.dataUrl ? require('./dataUrl').parseDataUrl(img.dataUrl) : null;
    if (parsed) {
      const up = await uploadMedia(creds, {
        buffer: Buffer.from(parsed.b64, 'base64'),
        mimeType: parsed.mimeType || img.mimeType,
      });
      // La subida falló (media muy grande para WhatsApp, tipo no soportado…):
      // se devuelve el error para que el envío se marque FALLIDO, no "enviado".
      if (!up.ok && !up.simulated) return { ok: false, status: up.status, error: up.error, data: up.data };
      if (up.ok) media = { id: up.id };
    }
  }
  // URL externa o media no resuelta: se envía por link (comportamiento previo).
  if (!media) media = { link: String(url || '') };

  // Las notas de voz no llevan pie: Meta rechaza el payload si el audio trae
  // caption (igual que en la app, donde a un audio no se le puede añadir texto).
  if (caption && kind !== 'audio') media.caption = String(caption).slice(0, 1024);
  return postToMeta(creds, {
    messaging_product: 'whatsapp',
    to: phone,
    type: kind,
    ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    [kind]: media,
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

module.exports = { DEFAULT_API_VERSION, isConfigured, sendText, sendMedia, uploadMedia, sendTemplate, sendBulk, downloadMedia };
