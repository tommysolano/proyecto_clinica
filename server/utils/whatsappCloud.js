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
 * Devuelve { ok, dataUrl, mimeType } o { ok:false }. Cap de tamaño: el tope que
 * WhatsApp admite por archivo (100 MB). Antes era 8 MB —un video de 16 MB que
 * llegaba de un contacto quedaba guardado SIN archivo y el agente veía "demasiado
 * grande para descargarlo"— pero ese tope era una reliquia de cuando la media se
 * guardaba como base64 DENTRO del documento de Mongo: ahora los bytes van al
 * disco (ver utils/chatMedia → mediaStore), que no tiene ese límite.
 */
async function downloadMedia(creds, mediaId, { maxBytes = 100 * 1024 * 1024 } = {}) {
  if (!isConfigured(creds)) return { ok: false, error: 'El número no tiene credenciales de Cloud API.' };
  if (!mediaId) return { ok: false, error: 'Meta no envió el identificador del archivo.' };
  const apiVersion = creds.apiVersion || DEFAULT_API_VERSION;
  try {
    const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${mediaId}`, {
      headers: { Authorization: `Bearer ${creds.accessToken}` },
    });
    const meta = await metaRes.json().catch(() => ({}));
    if (!metaRes.ok || !meta.url) {
      return { ok: false, error: meta?.error?.message || `Meta no devolvió la URL del archivo (HTTP ${metaRes.status})` };
    }
    const binRes = await fetch(meta.url, { headers: { Authorization: `Bearer ${creds.accessToken}` } });
    if (!binRes.ok) return { ok: false, error: `No se pudo descargar el archivo de Meta (HTTP ${binRes.status})` };
    const buf = Buffer.from(await binRes.arrayBuffer());
    if (buf.length > maxBytes) return { ok: false, tooLarge: true, mimeType: meta.mime_type, size: buf.length };
    // El mime de Meta puede traer parámetros ('audio/ogg; codecs=opus'): en la
    // cabecera de un data URL eso lo vuelve ilegible para el navegador.
    const mimeType = String(meta.mime_type || 'application/octet-stream').split(';')[0].trim().toLowerCase();
    return {
      ok: true,
      dataUrl: `data:${mimeType};base64,${buf.toString('base64')}`,
      mimeType,
      size: buf.length,
      filename: meta.filename || '',
    };
  } catch (err) {
    return { ok: false, error: err.message };
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
 * Envía botones de respuesta interactivos dentro de la ventana de 24 h.
 * WhatsApp Cloud admite como máximo tres botones `reply`; los CTA de enlace y
 * teléfono se convierten antes en enlaces rastreables dentro del texto.
 */
async function sendButtons(creds, to, body, buttons = [], contextMessageId) {
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: 'Teléfono inválido' };
  const replies = (buttons || [])
    .filter((button) => button?.text)
    .slice(0, 3)
    .map((button, index) => ({
      type: 'reply',
      reply: {
        id: String(button.providerId || button.id || `button_${index + 1}`).slice(0, 256),
        title: String(button.text).slice(0, 20),
      },
    }));
  if (!replies.length) return sendText(creds, to, body, contextMessageId);
  return postToMeta(creds, {
    messaging_product: 'whatsapp',
    to: phone,
    type: 'interactive',
    ...(contextMessageId ? { context: { message_id: contextMessageId } } : {}),
    interactive: {
      type: 'button',
      body: { text: String(body || 'Elige una opción:').slice(0, 1024) },
      action: { buttons: replies },
    },
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

/**
 * CACHÉ DE MEDIA IDS DE META (por adjunto y por número).
 *
 * La subida a Meta es la parte LENTA de cada envío con archivo: los bytes van
 * completos por multipart a graph.facebook.com. Una automatización que manda el
 * mismo PDF a 200 contactos —o una campaña, o un drip— repetía esa subida 200
 * veces: los mismos bytes, una vez por destinatario. El media id que Meta
 * devuelve es REUTILIZABLE dentro de la misma cuenta ( phoneNumberId ), así que
 * la primera subida se recuerda —en memoria del proceso y en el documento del
 * adjunto (ChatGalleryImage.metaMediaIds), para sobrevivir a un reinicio— y los
 * envíos siguientes reutilizan el id sin subir nada. TTL de 30 días por si Meta
 * recicla ids: vencido, se sube de nuevo sin más.
 */
const MEDIA_ID_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const metaMediaIdCache = new Map(); // `${phoneNumberId}:${attachmentId}` → { id, at }

function mediaIdFresco(hit) {
  return hit && hit.id && Date.now() - new Date(hit.at || 0).getTime() < MEDIA_ID_TTL_MS;
}

async function mediaIdDeCache(attachmentId, accountId) {
  const key = `${accountId}:${attachmentId}`;
  const mem = metaMediaIdCache.get(key);
  if (mediaIdFresco(mem)) return mem.id;
  // El doc del adjunto: la memoria se vació con un reinicio, pero la primera
  // subida quedó escrita en Mongo.
  const doc = await require('../models/ChatGalleryImage')
    .findById(attachmentId)
    .select('metaMediaIds')
    .lean()
    .catch(() => null);
  const hit = doc?.metaMediaIds?.[String(accountId)];
  if (mediaIdFresco(hit)) {
    metaMediaIdCache.set(key, { id: hit.id, at: hit.at || new Date().toISOString() });
    return hit.id;
  }
  return null;
}

function guardarMediaIdEnCache(attachmentId, accountId, mediaId) {
  if (!attachmentId || !accountId || !mediaId) return;
  const at = new Date().toISOString();
  metaMediaIdCache.set(`${accountId}:${attachmentId}`, { id: mediaId, at });
  // Best-effort: si Mongo falla, la memoria de proceso ya cubre esta tanda.
  require('../models/ChatGalleryImage')
    .updateOne(
      { _id: attachmentId },
      { $set: { [`metaMediaIds.${accountId}`]: { id: String(mediaId), at } } }
    )
    .catch(() => {});
}

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
    // Puerta única: resuelve el adjunto esté en disco (lo normal) o todavía en
    // base64 dentro de Mongo (anterior a la migración). Ver utils/mediaStore.
    const att = await require('./mediaStore').loadAttachment(selfHosted[1]).catch(() => null);
    if (!att) {
      console.warn('[wa-cloud sendMedia] adjunto propio ILEGIBLE id=%s (no se envía por link para no mentir "enviado")', selfHosted[1]);
      return { ok: false, errorCode: 'media_unreadable', error: 'No se pudo leer el archivo adjunto para enviarlo (media no encontrada o dañada).' };
    }
    buffer = att.buffer;
    byteMime = att.mimeType;
    docFilename = att.name || '';
  } else if (/^data:/i.test(String(url || ''))) {
    const parsed = require('./dataUrl').parseDataUrl(url);
    if (!parsed) {
      return { ok: false, errorCode: 'media_unreadable', error: 'Adjunto inválido (data URL dañado).' };
    }
    buffer = Buffer.from(parsed.b64, 'base64');
    byteMime = parsed.mimeType;
  }

  // Red de seguridad para los videos guardados ANTES de que las subidas se
  // normalizaran (ver utils/videoTranscode): Meta acepta un MP4 con pista HEVC
  // —devuelve media id y 200— y solo lo rechaza al entregarlo, por webhook, con
  // el 131053. Es preferible un error claro AHORA, que dice qué hacer, a un
  // mensaje que se pinta enviado y se vuelve rojo un rato después.
  if (buffer && kind === 'video' && require('./videoTranscode').looksLikeHevc(buffer)) {
    console.warn('[wa-cloud sendMedia] video HEVC/H.265 bloqueado antes de enviar (bytes=%d)', buffer.length);
    return {
      ok: false,
      errorCode: 'video_codec_no_soportado',
      error: 'El video está en H.265/HEVC y WhatsApp solo entrega H.264. Vuelve a subirlo al mensaje guardado: al subirlo ahora se convierte solo.',
    };
  }

  let media;
  if (buffer) {
    // Primero el caché: si este adjunto ya se subió a ESTA cuenta, Meta ya tiene
    // los bytes y el mensaje sale directo por media id (ver arriba).
    let mediaId = selfHosted
      ? await mediaIdDeCache(selfHosted[1], creds.phoneNumberId)
      : null;
    if (mediaId) {
      console.log('[wa-cloud sendMedia] media id en caché (sin re-subida) adjunto=%s cuenta=%s', selfHosted[1], creds.phoneNumberId);
    } else {
      const up = await uploadMedia(creds, { buffer, mimeType: byteMime });
      // La subida falló (media muy grande para WhatsApp, tipo no soportado…): se
      // devuelve el error para que el envío se marque FALLIDO, NO "enviado".
      if (!up.ok) {
        console.warn('[wa-cloud sendMedia] subida a Meta FALLÓ kind=%s mime=%s bytes=%d error=%s', kind, byteMime, buffer.length, up.error || '');
        return { ok: false, status: up.status, errorCode: 'media_upload_failed', error: up.error || 'No se pudo subir el archivo a WhatsApp.', data: up.data };
      }
      mediaId = up.id;
      if (selfHosted) guardarMediaIdEnCache(selfHosted[1], creds.phoneNumberId, mediaId);
      console.log('[wa-cloud sendMedia] subida OK id=%s kind=%s mime=%s bytes=%d', up.id, kind, byteMime, buffer.length);
    }
    media = { id: mediaId };
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

module.exports = { DEFAULT_API_VERSION, isConfigured, sendText, sendButtons, sendMedia, uploadMedia, metaUploadMime, sendTemplate, sendBulk, downloadMedia };
