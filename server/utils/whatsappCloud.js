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

// Meta Cloud API acepta un set CERRADO de MIME para documentos (ver error #100
// "Param file must be a file with one of the following types…"). Los formatos de
// TEXTO fuera de ese set (CSV, TSV, JSON, XML, Markdown, logs…) se suben como
// text/plain: Meta los acepta y el contacto los recibe igual, con su NOMBRE real
// (reco prueba.csv), porque el filename del documento es independiente del MIME.
const META_DOC_MIME = new Set([
  'text/plain', 'application/pdf', 'application/vnd.ms-powerpoint', 'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
]);
const TEXT_LIKE_MIME = /^(text\/|application\/(csv|json|x-ndjson|xml|xhtml\+xml|x-yaml|yaml|x-sh|javascript|x-www-form-urlencoded))/i;

/**
 * Ajusta el MIME de subida a lo que Meta acepta. Imagen/video/audio pasan tal
 * cual; un MIME de documento ya soportado se conserva; cualquier tipo TEXTO no
 * soportado (CSV, JSON, XML…) se degrada a text/plain para que Meta no lo rechace
 * con el error #100. Un binario exótico (zip, rar…) se deja como está: si Meta lo
 * rechaza, el envío se marca FALLIDO (la verdad), nunca "enviado" en falso.
 */
function metaUploadMime(mimeType) {
  const m = String(mimeType || '').split(';')[0].trim().toLowerCase() || 'application/octet-stream';
  if (m.startsWith('image/') || m.startsWith('video/') || m.startsWith('audio/')) return m;
  if (META_DOC_MIME.has(m)) return m;
  if (TEXT_LIKE_MIME.test(m)) return 'text/plain';
  return m;
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
  const mime = metaUploadMime(mimeType);
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

  // Bytes del adjunto. La media PROPIA (autoalojada /api/public/media/:id o un
  // data URL inline) SIEMPRE se sube a Meta y se envía por id. NO se cae al link:
  // enviar por link deja a Meta el trabajo de DESCARGAR nuestra URL y, cuando no
  // lo logra, ACEPTA el mensaje (200 → "enviado") pero NUNCA lo entrega — la causa
  // real de "media marcada como enviada que nunca llega". Solo las URLs EXTERNAS
  // (p.ej. cabecera de plantilla alojada fuera) van por link.
  let buffer = null;
  let byteMime = null;
  let docFilename = ''; // nombre real del archivo (documentos): lo ve el contacto
  const selfHosted = String(url || '').match(/\/api\/public\/media\/([a-f0-9]{24})/i);
  if (selfHosted) {
    const img = await require('../models/ChatGalleryImage')
      .findById(selfHosted[1])
      .select('dataUrl mimeType name')
      .lean()
      .catch(() => null);
    const parsed = img?.dataUrl ? require('./dataUrl').parseDataUrl(img.dataUrl) : null;
    if (!parsed) {
      console.warn('[wa-cloud sendMedia] adjunto propio ILEGIBLE id=%s (no se envía por link para no mentir "enviado")', selfHosted[1]);
      return { ok: false, errorCode: 'media_unreadable', error: 'No se pudo leer el archivo adjunto para enviarlo (media no encontrada o dañada).' };
    }
    buffer = Buffer.from(parsed.b64, 'base64');
    byteMime = parsed.mimeType || img.mimeType;
    docFilename = img?.name || '';
  } else if (/^data:/i.test(String(url || ''))) {
    const parsed = require('./dataUrl').parseDataUrl(url);
    if (!parsed) {
      return { ok: false, errorCode: 'media_unreadable', error: 'Adjunto inválido (data URL dañado).' };
    }
    buffer = Buffer.from(parsed.b64, 'base64');
    byteMime = parsed.mimeType;
  }

  let media;
  if (buffer) {
    const up = await uploadMedia(creds, { buffer, mimeType: byteMime });
    // La subida falló (media muy grande para WhatsApp, tipo no soportado…): se
    // devuelve el error para que el envío se marque FALLIDO, NO "enviado".
    if (!up.ok) {
      console.warn('[wa-cloud sendMedia] subida a Meta FALLÓ kind=%s mime=%s bytes=%d error=%s', kind, byteMime, buffer.length, up.error || '');
      return { ok: false, status: up.status, errorCode: 'media_upload_failed', error: up.error || 'No se pudo subir el archivo a WhatsApp.', data: up.data };
    }
    media = { id: up.id };
    console.log('[wa-cloud sendMedia] subida OK id=%s kind=%s mime=%s bytes=%d', up.id, kind, byteMime, buffer.length);
  } else {
    // URL externa: se envía por link (Meta la descarga; debe ser pública).
    media = { link: String(url || '') };
    console.log('[wa-cloud sendMedia] envío por LINK externo kind=%s url=%s', kind, String(url || '').slice(0, 120));
  }

  // Las notas de voz no llevan pie: Meta rechaza el payload si el audio trae
  // caption (igual que en la app, donde a un audio no se le puede añadir texto).
  if (caption && kind !== 'audio') media.caption = String(caption).slice(0, 1024);
  // Un documento se muestra con su NOMBRE de archivo (contrato.pdf), no como un
  // adjunto sin nombre: Meta lo toma del campo `filename` del objeto document.
  if (kind === 'document' && docFilename) media.filename = String(docFilename).slice(0, 240);
  const res = await postToMeta(creds, {
    messaging_product: 'whatsapp',
    to: phone,
    type: kind,
    ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    [kind]: media,
  });
  if (res.ok) {
    console.log('[wa-cloud sendMedia] Meta aceptó kind=%s wamid=%s', kind, res.data?.messages?.[0]?.id || '');
  } else {
    console.warn('[wa-cloud sendMedia] Meta RECHAZÓ el envío kind=%s error=%s', kind, res.error || '');
  }
  return res;
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

module.exports = { DEFAULT_API_VERSION, isConfigured, sendText, sendMedia, uploadMedia, metaUploadMime, sendTemplate, sendBulk, downloadMedia };
