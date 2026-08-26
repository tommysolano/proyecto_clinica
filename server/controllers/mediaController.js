const ChatGalleryImage = require('../models/ChatGalleryImage');
const mediaStore = require('../utils/mediaStore');
const { parseDataUrl } = require('../utils/dataUrl');

/**
 * Cabecera `Content-Disposition: attachment` para que el navegador GUARDE el
 * archivo en vez de mostrarlo (o de no hacer nada).
 *
 * POR QUÉ HACE FALTA. La descarga de un adjunto del chat se resolvía ENTERA en el
 * navegador: `fetch()` → Blob → `<a download>` sintético. Eso funciona en el
 * equipo donde se probó y falla en otros, siempre en silencio:
 *   - Firefox/Safari abortan la descarga si el object URL se revoca en el mismo
 *     tick del clic (era justo lo que hacía `triggerBlobDownload`);
 *   - Chrome BLOQUEA la descarga programática cuando el `await fetch` se comió la
 *     activación de usuario — basta una conexión lenta o un PDF grande;
 *   - y un PDF de 22 MB se cargaba entero en memoria antes de empezar a guardar.
 * Con esta cabecera el enlace se entrega DIRECTO al gestor de descargas del
 * navegador: sin fetch, sin blob, sin tope de tamaño y sin CORS de por medio.
 *
 * El nombre va DOS veces (RFC 6266): `filename` en ASCII para los navegadores
 * viejos y `filename*` en UTF-8 para conservar tildes y eñes — "MOREIRA MUÑOZ
 * ITALO.pdf" es un nombre real de producción.
 */
function attachmentDisposition(name, mimeType) {
  let clean = String(name || '')
    .split(/[\\/]/).pop()            // nunca una ruta, solo el nombre
    .replace(/[\r\n"\\]/g, '')       // nada que pueda partir la cabecera
    .trim()
    .slice(0, 180);
  if (!clean) clean = 'descarga';
  if (!/\.[a-z0-9]{1,8}$/i.test(clean)) clean += `.${mediaStore.extensionFor(mimeType)}`;
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  // encodeURIComponent deja pasar caracteres que no son `attr-char` (RFC 5987).
  const utf8 = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** ¿La petición pide GUARDAR el archivo (`?download=1`) en vez de mostrarlo? */
function wantsDownload(req) {
  const v = req?.query?.download;
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/**
 * Responde con los bytes de un data URL, atendiendo peticiones con `Range`
 * (206 Parcial): Safari/iOS NO reproduce audio ni video servido por URL si el
 * servidor no soporta rangos.
 */
function sendDataUrl(res, dataUrl, { fallbackMime = 'application/octet-stream', cache, range } = {}) {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return res.status(415).send('Unsupported');
  const buffer = Buffer.from(parsed.b64, 'base64');

  res.set('Content-Type', parsed.mimeType || fallbackMime);
  res.set('Cache-Control', cache || 'public, max-age=31536000, immutable');
  res.set('Accept-Ranges', 'bytes');

  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), buffer.length - 1) : buffer.length - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= buffer.length) {
      res.set('Content-Range', `bytes */${buffer.length}`);
      return res.status(416).end();
    }
    const chunk = buffer.subarray(start, end + 1);
    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${buffer.length}`);
    res.set('Content-Length', String(chunk.length));
    return res.send(chunk);
  }

  res.set('Content-Length', String(buffer.length));
  return res.send(buffer);
}

/**
 * GET /api/public/message-media/:messageId — adjunto de un mensaje que TODAVÍA lo
 * guarda inline (los anteriores a la migración a `utils/chatMedia`). Gracias a
 * esto el hilo puede devolverse sin los megas de base64 sin que esos mensajes
 * pierdan su foto, su nota de voz o su video. Tras correr
 * `migrateChatMediaToStorage.js --commit` deja de recibir tráfico, pero se
 * mantiene por si queda alguno suelto.
 */
exports.serveMessageMedia = async (req, res) => {
  try {
    const Message = require('../models/Message');
    const msg = await Message.findById(req.params.messageId).select('mediaUrl mediaName mediaType').lean();
    if (!msg?.mediaUrl) return res.status(404).send('Not found');
    const download = wantsDownload(req);
    // Ya migrado: se redirige a su URL definitiva (cacheable por el navegador).
    // El `?download=1` viaja con la redirección o el destino lo mostraría inline.
    if (!msg.mediaUrl.startsWith('data:')) {
      const target = download
        ? `${msg.mediaUrl}${msg.mediaUrl.includes('?') ? '&' : '?'}download=1`
        : msg.mediaUrl;
      return res.redirect(302, target);
    }
    if (download) {
      const mime = parseDataUrl(msg.mediaUrl)?.mimeType || 'application/octet-stream';
      res.set('Content-Disposition', attachmentDisposition(msg.mediaName, mime));
    }
    return sendDataUrl(res, msg.mediaUrl, { cache: 'private, max-age=86400', range: req.headers?.range });
  } catch (err) {
    return res.status(500).send('Error');
  }
};

/**
 * Sirve públicamente (sin auth) un adjunto del chat por su id, decodificando el
 * data URL base64 a bytes. Lo consumen:
 *   - el <img>/<audio>/<video> del chat y de la galería,
 *   - Meta, para las cabeceras de imagen de plantilla (la Cloud API no acepta
 *     data URLs, necesita una URL pública).
 *
 * OJO con el parseo de la cabecera: el navegador incluye el CODEC en el tipo al
 * grabar audio (Firefox produce `audio/ogg;codecs=opus`), así que el data URL
 * guardado puede ser `data:audio/ogg;codecs=opus;base64,…`. El patrón antiguo
 * `^data:([^;]+);base64,` NO casaba con eso y devolvía 415: las notas de voz
 * grabadas en Firefox no se podían escuchar en el chat, y Meta las rechazaba con
 * el error 131053 ("Media upload error") al bajarlas por link. Se usa
 * `parseDataUrl`, que parte por el marcador `;base64,` (lo único garantizado).
 *
 * Se responde a peticiones con `Range` (206 Parcial): Safari/iOS NO reproduce
 * audio ni video servido por URL si el servidor no soporta rangos.
 */
exports.serve = async (req, res) => {
  try {
    const img = await ChatGalleryImage.findById(req.params.id)
      .select('dataUrl storageKey mimeType name')
      .lean();
    if (!img) return res.status(404).send('Not found');

    // `?download=1`: el navegador lo guarda en vez de abrirlo. Ver
    // `attachmentDisposition` — es lo que permite descargar sin pasar por
    // fetch+Blob, que fallaba en unos equipos sí y en otros no.
    if (wantsDownload(req)) {
      res.set('Content-Disposition', attachmentDisposition(img.name, img.mimeType));
    }

    // Ruta normal desde jul-2026: el archivo está en el disco del servidor y se
    // envía por STREAM. Cargar en memoria un video de 15 MB por cada agente que
    // lo abre es justo lo que no queremos repetir.
    if (img.storageKey) {
      const total = await mediaStore.size(img.storageKey);
      if (total != null) {
        return streamFromDisk(res, img.storageKey, total, {
          mimeType: img.mimeType || 'application/octet-stream',
          range: req.headers?.range,
        });
      }
      console.error('[media] falta en disco %s (id=%s)', img.storageKey, req.params.id);
    }

    // Adjuntos anteriores a la migración: todavía con los bytes dentro de Mongo.
    if (!img.dataUrl) return res.status(404).send('Not found');
    return sendDataUrl(res, img.dataUrl, {
      fallbackMime: img.mimeType || 'application/octet-stream',
      range: req.headers?.range,
    });
  } catch (err) {
    return res.status(500).send('Error');
  }
};

/**
 * Envía un archivo del disco, atendiendo `Range` (206 Parcial). Los rangos no son
 * un lujo: sin ellos Safari/iOS no reproduce audio ni video servido por URL.
 */
function streamFromDisk(res, storageKey, total, { mimeType, range }) {
  res.set('Content-Type', mimeType);
  res.set('Cache-Control', 'public, max-age=31536000, immutable');
  res.set('Accept-Ranges', 'bytes');

  const m = range && /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
  if (m && (m[1] || m[2])) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= total) {
      res.set('Content-Range', `bytes */${total}`);
      return res.status(416).end();
    }
    res.status(206);
    res.set('Content-Range', `bytes ${start}-${end}/${total}`);
    res.set('Content-Length', String(end - start + 1));
    return mediaStore.createReadStream(storageKey, { start, end }).pipe(res);
  }

  res.set('Content-Length', String(total));
  return mediaStore.createReadStream(storageKey).pipe(res);
}
