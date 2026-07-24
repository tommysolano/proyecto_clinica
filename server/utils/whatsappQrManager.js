/**
 * Gestor de números de WhatsApp conectados por QR (whatsapp-web.js).
 *
 * Cada WhatsappAccount con connectionType='qr' tiene un Client de whatsapp-web.js
 * que mantiene una sesión tipo WhatsApp Web. La sesión se persiste EN DISCO con
 * LocalAuth (server/.wwebjs_auth/, ignorado por git y a salvo del `git reset` del
 * deploy): en el VPS el filesystem es persistente, así que sobrevive a reinicios
 * y redeploys. NO usar RemoteAuth (zips a Mongo): comprimir el perfil de Chrome
 * mientras Chrome lo escribe fallaba (ENOENT del zip) con una promesa sin manejar
 * que TUMBABA el proceso entero 60s después de cada vinculación, y al reiniciar
 * borraba el perfil local para "restaurar" desde un Mongo vacío (sesión perdida).
 *
 * Eventos → estado del número + socket.io:
 *   qr            → estado 'qr_pending'  + emite 'whatsapp:qr' (dataURL del QR)
 *   authenticated → estado 'syncing'     (QR escaneado, sincronizando sesión)
 *   loading_screen→ emite 'syncing' con % de progreso
 *   ready         → estado 'connected'   + guarda connectedPhone
 *   auth_failure  → estado 'auth_failure'
 *   disconnected  → estado 'disconnected'
 *   change_state  → UNPAIRED (desvinculado desde el teléfono) → 'disconnected'
 *   message       → ingesta entrante (mismo pipeline que el webhook Cloud API)
 *   message_ack   → actualiza el estado de entrega del mensaje saliente
 *
 * Los eventos NO bastan: al desvincular desde el teléfono, whatsapp-web.js a
 * veces no emite 'disconnected' y la sesión queda "conectada" para siempre.
 * Por eso hay un chequeo de salud periódico (getState) y una reconciliación
 * al listar los números, que detectan la sesión muerta y corrigen el estado.
 *
 * IMPORTANTE (hosting): whatsapp-web.js levanta un Chromium headless por número
 * (~300–500 MB) y requiere un proceso SIEMPRE activo. En Render gratis (RAM baja,
 * se duerme, FS efímero) será inestable; es plenamente usable en un VPS. Las libs
 * pesadas se cargan de forma diferida para que el server arranque aunque falten.
 */
const path = require('path');
const fs = require('fs');
const WhatsappAccount = require('../models/WhatsappAccount');
const { emitToCallCenter, emitToUser } = require('../realtime');

// Carpeta de sesiones LocalAuth (una subcarpeta session-<id> por número).
// Anclada a server/ (no al cwd) para que no dependa de cómo arranque pm2.
const WA_DATA_PATH = path.join(__dirname, '..', '.wwebjs_auth');

// accountId(string) → { client, status, watchdog, syncWatchdog, gotQr, lastQr, percent }
// lastQr guarda el último QR (dataURL) para que la UI pueda recuperarlo por
// sondeo HTTP si el socket se cayó y el evento 'whatsapp:qr' se perdió.
const clients = new Map();

// Reintentos de una sincronización COLGADA (QR escaneado pero 'ready' nunca
// llega, típico tras un reinicio del server). Se resetea al conectar bien.
const syncRetries = new Map();
// Sin progreso de sincronización durante este tiempo → se reinicia el cliente.
const SYNC_STUCK_MS = 3 * 60 * 1000;

// Cierra y limpia un cliente, persiste el estado final y lo emite a la UI.
async function teardown(key, entry, { status = 'disconnected', error = '' } = {}) {
  if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
  if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
  // Si ya hay OTRO cliente para este número (el usuario reconectó), solo se
  // destruye este: persistir/emitir aquí pisaría el estado de la conexión nueva.
  const replaced = clients.has(key) && clients.get(key) !== entry;
  if (!replaced) clients.delete(key);
  try { await entry.client.destroy(); } catch { /* noop */ }
  if (replaced) return;
  await setAccountStatus(key, { status });
  await emitStatus(key, { status, ...(error ? { error } : {}) });
}

/**
 * Verifica que una sesión 'connected' siga viva de verdad (getState).
 * - 'CONNECTED' → sigue viva.
 * - timeout → sin veredicto: NO se mata (Chrome puede estar ocupado).
 * - cualquier otro estado o error → sesión muerta (p.ej. desvinculada desde el
 *   teléfono sin que llegara el evento): se cierra y se marca 'disconnected'.
 */
async function verifyConnected(key, entry, timeoutMs = 8000) {
  let state = null;
  try {
    state = await withTimeout(entry.client.getState(), timeoutMs, '__timeout__');
  } catch (e) {
    if (String(e.message) === '__timeout__') return 'connected';
    state = null;
  }
  if (state === 'CONNECTED') return 'connected';
  if (clients.get(key) !== entry) return clients.get(key)?.status || 'disconnected';
  await teardown(key, entry, {
    error: 'La sesión se cerró (desvinculada desde el teléfono o expirada).',
  });
  return 'disconnected';
}

// Chequeo de salud periódico de todas las sesiones. Dos redes de seguridad:
//  - Sesión 'connected': verifica que siga viva (getState). Cubre "desvinculé
//    desde el celular y no llegó ningún evento".
//  - Sesión con cliente pero estado NO 'connected' (pegada en 'syncing'/
//    'connecting' porque whatsapp-web.js re-sincronizó sin re-emitir 'ready'):
//    si getState dice CONNECTED, se CURA a 'connected'. Sin esto, un número que
//    en realidad funciona (recibe mensajes, el teléfono envía) rechazaba todos
//    los envíos del sistema con "QR no conectado".
let healthTimer = null;
function ensureHealthTimer() {
  if (healthTimer) return;
  healthTimer = setInterval(async () => {
    for (const [key, entry] of Array.from(clients.entries())) {
      if (entry.status === 'connected') {
        // eslint-disable-next-line no-await-in-loop
        await verifyConnected(key, entry, 10000).catch(() => {});
      } else if (entry.client && ['syncing', 'connecting'].includes(entry.status)) {
        let live = null;
        try {
          // eslint-disable-next-line no-await-in-loop
          live = await withTimeout(entry.client.getState(), 8000, '__timeout__');
        } catch {
          live = null;
        }
        if (live === 'CONNECTED') healToConnected(key, entry);
      }
    }
  }, 45000);
  healthTimer.unref?.();
}

// Borra la sesión local de un número. Solo se usa para cuentas que nunca
// llegaron a vincularse: un perfil a medias/corrupto haría fallar los
// intentos siguientes.
async function wipeLocalSession(sessionId) {
  try {
    await fs.promises.rm(path.join(WA_DATA_PATH, `session-${sessionId}`), {
      recursive: true,
      force: true,
      maxRetries: 3,
    });
  } catch {
    /* noop */
  }
}

// Ruta al ejecutable de Chrome para whatsapp-web.js. Por defecto reutiliza el
// MISMO Chromium que el proyecto ya usa para generar PDFs (puppeteer), evitando
// que whatsapp-web.js busque el Chrome de su propio puppeteer (que no se descarga
// en Render). En el VPS se puede forzar con PUPPETEER_EXECUTABLE_PATH.
function resolveChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) return process.env.PUPPETEER_EXECUTABLE_PATH;
  try {
    return require('puppeteer').executablePath();
  } catch {
    return undefined;
  }
}

// Emite el estado de un número a la UI del call center (sala global) y al usuario.
async function emitStatus(accountId, payload, userId) {
  try {
    emitToCallCenter('whatsapp:status', { accountId: String(accountId), ...payload });
    if (userId) emitToUser(userId, 'whatsapp:status', { accountId: String(accountId), ...payload });
  } catch {
    /* noop */
  }
}

async function setAccountStatus(accountId, patch) {
  return WhatsappAccount.findByIdAndUpdate(accountId, patch, { new: true }).catch(() => null);
}

const ACK_STATUS = { '-1': 'failed', 1: 'sent', 2: 'delivered', 3: 'read', 4: 'read' };

// Tipo de whatsapp-web.js → enum de Message.mediaType. 'ptt' es la nota de voz.
// 'sticker' se conserva como tal para pintarlo pequeño/transparente en el chat.
function mapQrMediaType(t) {
  if (t === 'ptt') return 'audio';
  if (['image', 'audio', 'video', 'document', 'sticker'].includes(t)) return t;
  return 'document';
}

// Tope de bytes de una media entrante que se guarda en Mongo: el mensaje lleva el
// data URL base64 embebido y un documento BSON no puede pasar de 16 MB. Por encima
// de esto el mensaje se guarda SIN los bytes (pero se ve en el chat qué llegó).
const MAX_QR_MEDIA_BYTES = 8 * 1024 * 1024;

// Reintentos de descarga. WhatsApp Web emite el mensaje ANTES de terminar de bajar
// la media (mediaData.mediaStage = 'FETCHING') y whatsapp-web.js devuelve
// `undefined` en ese instante. Con un solo intento se perdía TODA la media entrante
// del número QR: 1600+ mensajes recibidos y ni una sola foto/audio guardados.
const MEDIA_RETRY_DELAYS = [0, 900, 2200, 4000, 6000];

// Tiempo máximo total esperando el archivo de UN mensaje (el resto de mensajes
// sigue entrando en paralelo; esto solo evita esperas eternas si el navegador
// se queda colgado).
const MAX_MEDIA_WAIT_MS = 45000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms).unref?.());
}

// El mime de whatsapp-web.js puede traer parámetros ('audio/ogg; codecs=opus').
// En la cabecera de un data URL eso rompe a los navegadores (y a nuestro servidor
// de media), así que se guarda solo el tipo base.
function cleanMime(mimeType, fallback) {
  const m = String(mimeType || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(m) ? m : fallback;
}

/** Un identificador de WhatsApp (Wid) como texto: '5939…@c.us' / '2044…@lid'. */
function widToString(w) {
  if (!w) return '';
  if (typeof w === 'string') return w;
  if (w._serialized) return w._serialized;
  if (w.user && w.server) return `${w.user}@${w.server}`;
  return '';
}

/**
 * Clave COMPLETA de un mensaje ('false_2044…@lid_ACE14EA2…').
 *
 * En los chats de número oculto (@lid) whatsapp-web.js NO expone `id._serialized`,
 * y todo lo que identifica un mensaje por id se rompía: la descarga de archivos
 * (`downloadMedia` busca `Msg.get(this.id._serialized)` → undefined) y el botón de
 * reintentar ("Invalid serialized message id specified"). Por eso en el número QR
 * no entraba NI UNA foto ni nota de voz de esos contactos. Aquí se reconstruye a
 * partir de sus piezas, que sí vienen (`fromMe`, `remote`, `id`).
 */
function serializeMsgKey(idObj) {
  if (!idObj) return '';
  if (typeof idObj === 'string') return idObj;
  if (idObj._serialized) return idObj._serialized;
  const remote = widToString(idObj.remote);
  const hash = idObj.id || '';
  if (!remote || !hash) return '';
  const parts = [idObj.fromMe ? 'true' : 'false', remote, hash];
  const participant = widToString(idObj.participant);
  if (participant) parts.push(participant);
  return parts.join('_');
}

/** Clave completa de un mensaje de whatsapp-web.js (ver serializeMsgKey). */
function qrMessageId(msg) {
  return msg?.id?._serialized || serializeMsgKey(msg?.id) || serializeMsgKey(msg?._data?.id) || '';
}

/** Parte única (hash) de la clave de un mensaje, sirva o no el resto. */
function qrMessageHash(msg) {
  const raw = msg?.id?.id || msg?._data?.id?.id || '';
  if (raw) return String(raw);
  const parts = String(qrMessageId(msg) || '').split('_');
  return parts.length >= 3 ? parts[2] : '';
}

/**
 * Descarga la media POR EL CAMINO DE LA PROPIA APP de WhatsApp Web, dentro del
 * navegador. Es el plan B cuando `msg.downloadMedia()` de whatsapp-web.js falla.
 *
 * La librería llama directamente a `WAWebDownloadManager.downloadAndMaybeDecrypt`
 * con un puñado de campos del mensaje; cuando WhatsApp cambia esa función interna
 * (pasa en cada actualización de WhatsApp Web) revienta con un error MINIFICADO
 * —en producción llegaba literalmente como "r"— y se perdía todo archivo entrante
 * del número QR.
 *
 * Aquí se hace lo mismo que hace la app cuando pulsas "descargar": se le pide al
 * modelo del mensaje que RESUELVA su media (`msg.downloadMedia`, el método del
 * propio WhatsApp, no el de la librería) y luego se leen los bytes ya descifrados
 * del blob que queda en memoria (`mediaData.mediaBlob`). Al no depender de firmas
 * internas, sobrevive a los cambios de WhatsApp Web.
 *
 * @returns {{ok:boolean, data?:string, mimetype?:string, filename?:string, filesize?:number, via?:string, error?:string}}
 */
async function downloadQrMediaInPage(client, serializedId, hash = '') {
  if (!client?.pupPage || (!serializedId && !hash)) return { ok: false, error: 'sin sesión o sin id de mensaje' };
  return withTimeout(
    client.pupPage.evaluate(async (id, msgHash) => {
      // Descripción legible de un error del navegador (suelen venir minificados).
      const desc = (e) => {
        const parts = [e && e.message, e && e.name, e && e.constructor && e.constructor.name, String(e)];
        return parts.filter(Boolean).join(' / ').slice(0, 200);
      };
      try {
        const col = window.require('WAWebCollections');
        let msg = null;
        if (id) {
          try {
            msg = col.Msg.get(id) || (await col.Msg.getMessagesById([id]))?.messages?.[0] || null;
          } catch (e) {
            msg = null; // id no serializable (chats @lid): se busca por el hash
          }
        }
        // Rescate por HASH: identifica el mensaje aunque su clave completa no sirva.
        if (!msg && msgHash) {
          const models = typeof col.Msg.getModelsArray === 'function'
            ? col.Msg.getModelsArray()
            : (col.Msg.models || []);
          msg = models.find((m) => m && m.id && m.id.id === msgHash) || null;
        }
        if (!msg) return { ok: false, error: 'el mensaje no está en el store de WhatsApp Web' };

        // 1) Que WhatsApp resuelva su propia media (descarga + descifrado).
        let resolveError = '';
        try {
          if (!msg.mediaData || msg.mediaData.mediaStage !== 'RESOLVED') {
            await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
          }
        } catch (e) {
          resolveError = desc(e);
        }

        // 2) Bytes ya descifrados en memoria. `url()` (un blob: del navegador) es
        //    la vía que usa la propia librería para pintar la media, así que es la
        //    más estable; se dejan alternativas por si cambia el objeto.
        const blob = msg.mediaData && msg.mediaData.mediaBlob;
        let real = null;
        if (blob) {
          try {
            if (typeof Blob !== 'undefined' && blob instanceof Blob) real = blob;
            else if (typeof blob.forceToBlob === 'function') real = await blob.forceToBlob();
            else if (blob._blob) real = blob._blob;
            else if (typeof blob.url === 'function') {
              const u = blob.url();
              if (u) real = await (await fetch(u)).blob();
            }
          } catch (e) {
            return { ok: false, error: `no se pudieron leer los bytes (${desc(e)})` };
          }
        }
        if (!real) {
          const stage = (msg.mediaData && msg.mediaData.mediaStage) || '(sin mediaData)';
          return { ok: false, error: `sin bytes en memoria — mediaStage=${stage}${resolveError ? ` resolve=${resolveError}` : ''}` };
        }

        const buf = await real.arrayBuffer();
        const data = await window.WWebJS.arrayBufferToBase64Async(buf);
        return {
          ok: true,
          data,
          mimetype: msg.mimetype || real.type || 'application/octet-stream',
          filename: msg.filename || '',
          filesize: Number(msg.size) || buf.byteLength,
          via: 'mediaBlob',
        };
      } catch (e) {
        return { ok: false, error: desc(e) };
      }
    }, serializedId || '', hash || ''),
    30000,
    'timeout descargando la media desde el navegador'
  ).catch((e) => ({ ok: false, error: e.message }));
}

/**
 * Por qué WhatsApp Web no entregó la media (queda en el log del VPS para poder
 * arreglar la causa exacta sin acceso al navegador). Pregunta al store en qué
 * estado quedó el mensaje: 'FETCHING' = seguía bajando, 'ERROR…' = falló la
 * descarga, 'REUPLOADING' = media caducada en el teléfono del contacto.
 */
async function describeMediaFailure(client, serializedId) {
  if (!client?.pupPage || !serializedId) return '';
  try {
    const info = await withTimeout(
      client.pupPage.evaluate(async (id) => {
        try {
          const col = window.require('WAWebCollections');
          const m = col.Msg.get(id) || (await col.Msg.getMessagesById([id]))?.messages?.[0];
          if (!m) return 'el mensaje no está en el store de WhatsApp Web';
          return `mediaStage=${m.mediaData?.mediaStage || '(sin mediaData)'} directPath=${m.directPath ? 'sí' : 'no'} mediaKey=${m.mediaKey ? 'sí' : 'no'}`;
        } catch (e) {
          return `no se pudo inspeccionar (${e.message})`;
        }
      }, serializedId),
      8000,
      'timeout inspeccionando el mensaje'
    );
    return String(info || '');
  } catch (e) {
    return `no se pudo inspeccionar (${e.message})`;
  }
}

/**
 * Descarga la media inline de un mensaje QR y arma el objeto media para la
 * ingesta ({ type, dataUrl, caption, filename, size }).
 *
 * Devuelve `null` SOLO si el mensaje no trae media. Si la trae pero no se pudo
 * bajar, devuelve el objeto con `unavailable: true` y SIN dataUrl: el mensaje se
 * guarda igual y el agente ve "📷 Foto (no disponible)" en el chat. Nunca se
 * descarta un mensaje con media —desaparecía del chat sin dejar rastro—.
 */
async function extractQrMedia(msg, client, { retryDelays = MEDIA_RETRY_DELAYS } = {}) {
  if (!msg.hasMedia) return null;
  const type = mapQrMediaType(msg.type);
  const filename = msg._data?.filename || '';
  const size = Number(msg._data?.size) || 0;
  const base = { type, caption: msg.body || '', filename, size };
  // Clave RECONSTRUIDA si hace falta: en chats @lid la librería no la expone y sin
  // ella no se puede localizar el mensaje para bajar su archivo (ver qrMessageId).
  const serializedId = qrMessageId(msg);
  const hash = qrMessageHash(msg);
  let lastError = '';
  // Tope total: el mensaje espera a su archivo, así que reintentar no puede
  // retrasarlo eternamente si cada llamada al navegador se queda colgada.
  const deadline = Date.now() + MAX_MEDIA_WAIT_MS;

  // Empaqueta los bytes ya en base64 (vengan de donde vengan) para la ingesta.
  const pack = (data, mimetype, name, informedSize) => {
    const bytes = Math.floor(data.length * 0.75);
    if (bytes > MAX_QR_MEDIA_BYTES) {
      console.warn('[whatsapp-qr media] %s demasiado grande (%d bytes): se guarda sin el archivo', type, bytes);
      return { ...base, size: bytes, unavailable: true, error: 'El archivo es demasiado grande para guardarlo.' };
    }
    return {
      ...base,
      dataUrl: `data:${cleanMime(mimetype, 'application/octet-stream')};base64,${data}`,
      filename: name || filename,
      size: bytes || informedSize || size,
    };
  };

  for (let i = 0; i < retryDelays.length; i += 1) {
    if (i > 0 && Date.now() > deadline) {
      lastError = lastError || 'WhatsApp Web tardó demasiado en entregar el archivo';
      break;
    }
    if (retryDelays[i]) await sleep(retryDelays[i]);
    try {
      // Desde el 2º intento se RELEE el mensaje del store: el objeto que llegó con
      // el evento puede quedarse con un modelo viejo cuya media nunca se resuelve.
      let target = msg;
      if (i > 0 && serializedId && client) {
        const fresh = await withTimeout(client.getMessageById(serializedId), 10000, 'timeout releyendo el mensaje')
          .catch(() => null);
        if (fresh && fresh.hasMedia) target = fresh;
      }
      // eslint-disable-next-line no-await-in-loop
      const m = await withTimeout(target.downloadMedia(), 15000, 'timeout descargando la media');
      if (m && m.data) return pack(m.data, m.mimetype, m.filename);
      lastError = 'WhatsApp Web aún no tenía la media descargada';
    } catch (e) {
      lastError = e.message || String(e);
    }

    // Plan B: la vía de la propia app (ver downloadQrMediaInPage). Se intenta en
    // CADA vuelta porque cuando WhatsApp cambia sus funciones internas el camino
    // de la librería falla SIEMPRE, y sin esto no entraría ni un archivo.
    if (client && (serializedId || hash)) {
      // eslint-disable-next-line no-await-in-loop
      const alt = await downloadQrMediaInPage(client, serializedId, hash);
      if (alt.ok && alt.data) {
        console.log('[whatsapp-qr media] descargada por la vía alterna (%s) type=%s', alt.via, type);
        return pack(alt.data, alt.mimetype, alt.filename, alt.filesize);
      }
      if (alt.error) lastError = `${lastError} | alterna: ${alt.error}`;
    }
  }

  const why = await describeMediaFailure(client, serializedId);
  console.warn(
    '[whatsapp-qr media] NO se pudo descargar type=%s id=%s tras %d intentos: %s | %s',
    msg.type, serializedId || '(sin id)', retryDelays.length, lastError, why
  );
  return { ...base, unavailable: true, error: lastError || 'No se pudo descargar la media de WhatsApp.' };
}

/**
 * Texto legible para los mensajes QR que no son texto ni media (ubicación,
 * tarjeta de contacto). Sin esto se descartaban en silencio por "no tener nada
 * que mostrar" y el agente nunca se enteraba de que el paciente le mandó algo.
 */
function describeQrNonMedia(msg) {
  if (msg.type === 'location') {
    const loc = msg.location || msg._data?.location || {};
    const name = loc.name || loc.description || loc.address || '';
    return `📍 Ubicación${name ? `: ${String(name).slice(0, 120)}` : ''}`;
  }
  if (msg.type === 'vcard' || msg.type === 'multi_vcard') {
    const raw = String(msg.body || msg._data?.vcard || '');
    const fn = /(?:^|\n)FN:(.+)/i.exec(raw);
    return `👤 Contacto compartido${fn ? `: ${fn[1].trim().slice(0, 80)}` : ''}`;
  }
  return '';
}

// Atribución click-to-WhatsApp (anuncios Meta) para números QR. En Cloud API el
// webhook trae `referral`; en QR, whatsapp-web.js 1.34.x NO expone el contexto del
// anuncio como propiedad, pero `getMessageModel` vuelca el modelo COMPLETO en
// `_data`, así que —si WhatsApp Web lo incluye— llega ahí en crudo bajo algún
// campo. Lo buscamos de forma defensiva (varias formas conocidas/probables) y lo
// devolvemos con la MISMA forma que espera ingestExternalMessage (adId, headline…).
// Devuelve null si no hay señales de anuncio.
// ¿Este objeto parece el contexto de un anuncio? (trae id o url de la fuente).
function looksLikeAdCtx(o) {
  return !!(o && typeof o === 'object' &&
    (o.sourceUrl || o.source_url || o.sourceId || o.source_id || o.ctwaClid || o.ctwa_clid || o.ctwaSignals));
}

function extractQrReferral(msg) {
  const d = msg && msg._data;
  if (!d || typeof d !== 'object') return null;

  // Ubicaciones conocidas/probables (plano y anidado en contextInfo/quoted).
  const candidates = [
    d.ctwaContext, d.ctwaContextData, d.adReplyMetadata, d.externalAdReply,
    d.contextInfo && d.contextInfo.externalAdReply, d.contextInfo && d.contextInfo.ctwaContext,
    d.quotedAd && (d.quotedAd.ctwaContext || d.quotedAd),
  ];
  let ctx = candidates.find(looksLikeAdCtx) || null;

  // Rescate: barre un nivel (por si la clave cambió entre versiones de la librería).
  if (!ctx) {
    for (const v of Object.values(d)) {
      if (looksLikeAdCtx(v)) { ctx = v; break; }
      if (v && typeof v === 'object' && (looksLikeAdCtx(v.externalAdReply) || looksLikeAdCtx(v.ctwaContext))) {
        ctx = v.externalAdReply || v.ctwaContext; break;
      }
    }
  }
  if (!ctx || typeof ctx !== 'object') return null;

  const adId = ctx.sourceId || ctx.source_id || ctx.adId || '';
  const sourceUrl = ctx.sourceUrl || ctx.source_url || ctx.url || '';
  const headline = ctx.title || ctx.headline || '';
  const body = ctx.description || ctx.body || '';
  const sourceType = ctx.sourceType || ctx.source_type || (ctx.mediaType != null ? String(ctx.mediaType) : '');
  const ctwaClid = ctx.ctwaClid || ctx.ctwa_clid || '';
  if (!adId && !sourceUrl && !headline && !body) return null;
  return { adId, sourceUrl, headline, body, sourceType, ctwaClid, campaign: headline || body };
}

// Caché lid→teléfono real (el mapeo es estable, se guarda por proceso).
const lidPhoneCache = new Map();

/**
 * Devuelve los DÍGITOS del número real de un contacto QR a partir de su JID.
 *  - `…@c.us`: los dígitos ya SON el número real.
 *  - `…@lid` (número oculto): WhatsApp no expone el teléfono en el JID; se lo pedimos
 *    con `getContactLidAndPhone` (mapa lid→pn de whatsapp-web.js, que hasta consulta
 *    a WhatsApp si hace falta). Si no se puede resolver, cae a los dígitos del LID
 *    (comportamiento anterior) y se reintenta en el próximo mensaje.
 */
async function resolveQrPhone(client, jid) {
  const s = String(jid || '');
  const raw = s.replace(/@.*$/, '').replace(/\D/g, '');
  if (!s.endsWith('@lid')) return raw;
  if (lidPhoneCache.has(s)) return lidPhoneCache.get(s) || raw;
  try {
    const out = await withTimeout(client.getContactLidAndPhone([s]), 8000, null);
    const res = Array.isArray(out) ? out[0] : null;
    const pn = res && res.pn ? String(res.pn) : '';
    if (pn.endsWith('@c.us')) {
      const digits = pn.replace(/@.*$/, '').replace(/\D/g, '');
      if (digits) { lidPhoneCache.set(s, digits); return digits; }
    }
  } catch { /* no se pudo resolver ahora: cae al LID */ }
  return raw;
}

/**
 * Inicia (o reutiliza) el cliente de un número QR. `userId` se usa para mandarle
 * el QR directamente a quien pulsó "Conectar".
 */
async function connect(accountId, { userId } = {}) {
  const key = String(accountId);
  const existing = clients.get(key);
  if (existing && existing.client) {
    if (existing.status === 'connected') {
      // Ya figura conectado: verificar que la sesión siga VIVA antes de reusarla
      // (si se desvinculó desde el teléfono sin evento, aquí se detecta y se
      // sigue con una conexión desde cero en vez de reemitir un estado falso).
      const still = await verifyConnected(key, existing, 6000).catch(() => 'connected');
      if (still === 'connected') {
        await emitStatus(key, { status: 'connected' }, userId);
        return { ok: true, status: 'connected' };
      }
    } else {
      // Cliente vivo pero NO conectado (p.ej. quedó en 'connecting' colgado, o en
      // 'qr_pending' con un QR que ya caducó — típico tras initEnabledOnBoot).
      // Antes se reusaba y solo se reemitía el estado, sin volver a generar el QR:
      // el botón "Conectar" quedaba muerto hasta reiniciar el server. Ahora se
      // destruye y se arranca de cero para garantizar un QR fresco.
      clients.delete(key);
      if (existing.watchdog) clearTimeout(existing.watchdog);
      if (existing.syncWatchdog) clearTimeout(existing.syncWatchdog);
      try { await existing.client.destroy(); } catch { /* noop */ }
    }
  }

  const account = await WhatsappAccount.findById(accountId);
  if (!account || account.connectionType !== 'qr') {
    return { ok: false, error: 'Número QR no encontrado' };
  }

  let Client;
  let LocalAuth;
  let QRCode;
  try {
    ({ Client, LocalAuth } = require('whatsapp-web.js'));
    QRCode = require('qrcode');
  } catch (e) {
    await setAccountStatus(accountId, { status: 'auth_failure' });
    return { ok: false, error: `No se pudo cargar whatsapp-web.js: ${e.message}` };
  }

  const sessionId = account.sessionId || `wa_${key}`;
  if (!account.sessionId) {
    account.sessionId = sessionId;
    await account.save();
  }

  let client;
  try {
    client = new Client({
      authStrategy: new LocalAuth({
        clientId: sessionId,
        dataPath: WA_DATA_PATH,
      }),
      // El UA por defecto de whatsapp-web.js es Chrome 101 (2022): WhatsApp Web
      // rechaza navegadores tan viejos y expulsa la sesión antes de dar el QR.
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      // 'local' (default) intercepta y sirve un HTML viejo de WhatsApp Web
      // (webVersion 2.3000.1017054665) que el servidor de WhatsApp ya no acepta.
      webVersionCache: { type: 'none' },
      puppeteer: {
        headless: true,
        executablePath: resolveChromePath() || undefined,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
      },
    });
  } catch (e) {
    await setAccountStatus(accountId, { status: 'auth_failure' });
    return { ok: false, error: `No se pudo crear el cliente: ${e.message}` };
  }

  const entry = { client, status: 'connecting', watchdog: null, syncWatchdog: null, gotQr: false, lastQr: '', percent: null };
  clients.set(key, entry);
  ensureHealthTimer();
  await setAccountStatus(accountId, { status: 'connecting' });
  await emitStatus(key, { status: 'connecting' }, userId);

  // Watchdog: si en 90s no salió ni un QR ni conectó (Chrome colgado, sesión
  // corrupta, red), se mata el cliente y se avisa, en vez de dejar la UI en
  // "Generando código QR…" para siempre. No aplica si ya hubo QR (el usuario
  // puede tardar en escanear y la sincronización posterior también toma tiempo).
  entry.watchdog = setTimeout(async () => {
    const cur = clients.get(key);
    if (!cur || cur.client !== client || cur.gotQr || cur.status !== 'connecting') return;
    clients.delete(key);
    try { await client.destroy(); } catch { /* noop */ }
    const fresh = await WhatsappAccount.findById(accountId).catch(() => null);
    if (fresh && !fresh.connectedPhone) await wipeLocalSession(sessionId);
    await setAccountStatus(accountId, { status: 'auth_failure' });
    await emitStatus(key, {
      status: 'auth_failure',
      error: 'No se pudo generar el QR en 90 segundos. Vuelve a pulsar "Conectar".',
    }, userId);
  }, 90000);

  client.on('qr', async (qr) => {
    entry.status = 'qr_pending';
    entry.gotQr = true;
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    await setAccountStatus(accountId, { status: 'qr_pending', lastQrAt: new Date() });
    let dataUrl = '';
    try {
      dataUrl = await QRCode.toDataURL(qr);
    } catch {
      /* noop */
    }
    entry.lastQr = dataUrl; // respaldo para el sondeo HTTP si el socket está caído
    const payload = { status: 'qr_pending', qr: dataUrl };
    emitToCallCenter('whatsapp:qr', { accountId: key, ...payload });
    if (userId) emitToUser(userId, 'whatsapp:qr', { accountId: key, ...payload });
  });

  // Watchdog de SINCRONIZACIÓN: tras escanear el QR (o al reconectar con la
  // sesión guardada), whatsapp-web.js a veces nunca emite 'ready' y el número
  // queda "sincronizando…" para siempre (típico tras un deploy) — y con él
  // fallan todos los envíos de las automatizaciones. Cada señal de progreso
  // re-arma el timer; si pasa SYNC_STUCK_MS sin llegar a 'ready', se destruye
  // el cliente y se reintenta UNA vez desde la sesión guardada (sin QR nuevo);
  // si vuelve a colgarse, queda 'disconnected' con el motivo visible.
  const armSyncWatchdog = () => {
    if (entry.syncWatchdog) clearTimeout(entry.syncWatchdog);
    entry.syncWatchdog = setTimeout(async () => {
      const cur = clients.get(key);
      if (!cur || cur.client !== client || cur.status !== 'syncing') return;
      clients.delete(key);
      try { await client.destroy(); } catch { /* noop */ }
      const retries = syncRetries.get(key) || 0;
      if (retries < 1) {
        syncRetries.set(key, retries + 1);
        console.warn(`[whatsappQr] sincronización colgada en ${key}; reintentando desde la sesión guardada`);
        await emitStatus(key, { status: 'connecting' }, userId);
        connect(accountId, { userId }).catch(() => {});
        return;
      }
      syncRetries.delete(key);
      await setAccountStatus(accountId, { status: 'disconnected' });
      await emitStatus(key, {
        status: 'disconnected',
        error: 'La sincronización no terminó (WhatsApp no confirmó la sesión). Pulsa "Conectar" para reintentar.',
      }, userId);
    }, SYNC_STUCK_MS);
    entry.syncWatchdog.unref?.();
  };

  client.on('ready', async () => {
    entry.status = 'connected';
    entry.lastQr = '';
    entry.percent = null;
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
    syncRetries.delete(key);
    const connectedPhone = (client.info?.wid?.user || '').toString();
    await setAccountStatus(accountId, {
      status: 'connected',
      connectedPhone,
      lastConnectedAt: new Date(),
    });
    await emitStatus(key, { status: 'connected', connectedPhone }, userId);
  });

  // QR escaneado: WhatsApp sincroniza la sesión hasta 'ready'. Antes esta fase
  // era muda y la UI seguía diciendo "Escanea el QR" — ahora se avisa.
  client.on('authenticated', async () => {
    entry.status = 'syncing';
    entry.lastQr = '';
    armSyncWatchdog();
    await setAccountStatus(accountId, { status: 'syncing' });
    await emitStatus(key, { status: 'syncing' }, userId);
  });

  // Progreso de la sincronización (0-100). No se persiste; solo informa a la UI.
  // Cada avance re-arma el watchdog (hay vida: no matar una sync lenta).
  client.on('loading_screen', async (percent) => {
    entry.status = 'syncing';
    entry.percent = Number(percent) || 0;
    armSyncWatchdog();
    await emitStatus(key, { status: 'syncing', percent: entry.percent }, userId);
  });

  client.on('auth_failure', async () => {
    entry.status = 'auth_failure';
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
    await setAccountStatus(accountId, { status: 'auth_failure' });
    await emitStatus(key, { status: 'auth_failure' }, userId);
  });

  client.on('disconnected', async (reason) => {
    await teardown(key, entry, {
      error: String(reason || '').toUpperCase() === 'LOGOUT'
        ? 'La sesión se cerró desde el teléfono (dispositivo desvinculado).'
        : '',
    });
  });

  // Desvinculación detectada por cambio de estado (a veces 'disconnected' no llega).
  client.on('change_state', async (state) => {
    if (state === 'UNPAIRED' || state === 'UNPAIRED_IDLE') {
      if (clients.get(key) !== entry) return;
      await teardown(key, entry, { error: 'El teléfono desvinculó este dispositivo.' });
    }
  });

  // Mensaje entrante → mismo pipeline de ingesta que el webhook Cloud API.
  // Tipos con contenido real de un humano; el resto (e2e_notification al
  // renegociar cifrado, notification_template, ciphertext, llamadas, etc.)
  // NO debe crear conversaciones: al vincular una sesión nueva, WhatsApp
  // renegocia claves con muchos contactos y llegaba un "mensaje" vacío por
  // cada uno (chats fantasma "Sin mensajes" con el LID como nombre).
  const CONTENT_TYPES = ['chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'vcard', 'multi_vcard'];
  client.on('message', async (msg) => {
    try {
      if (msg.fromMe || msg.isStatus) return;
      const from = typeof msg.from === 'string' ? msg.from : '';
      // Solo chats directos: personas (@c.us) o contactos con número oculto (@lid).
      // Fuera grupos (@g.us), canales (@newsletter) y listas (@broadcast).
      if (!/@(c\.us|lid)$/.test(from)) return;
      if (!CONTENT_TYPES.includes(msg.type)) return;
      // Número real: si el contacto tiene número oculto (@lid) lo resolvemos a su
      // teléfono verdadero (si no, se mostraría el identificador largo del LID).
      const phone = await resolveQrPhone(client, from);
      if (!phone) return;

      const media = await extractQrMedia(msg, client);
      // Ubicación / tarjeta de contacto: no traen texto ni media, pero SÍ son un
      // mensaje real del paciente; se describen en vez de descartarse (y en el
      // vcard se muestra el nombre, no el volcado crudo del contacto).
      const described = describeQrNonMedia(msg);
      const bodyText = described || String(msg.body || '').trim();
      if (!bodyText && !media) return; // nada que mostrar

      const account2 = await WhatsappAccount.findById(accountId);
      const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
      if (!clinicId) return;

      // Cita: si el contacto respondió a un mensaje, whatsapp-web.js expone el
      // wamid citado en _data.quotedStanzaID (o hasQuotedMsg + getQuotedMessage).
      let contextId = '';
      if (msg.hasQuotedMsg) {
        try {
          const q = await msg.getQuotedMessage();
          contextId = qrMessageId(q) || msg._data?.quotedStanzaID || '';
        } catch {
          contextId = msg._data?.quotedStanzaID || '';
        }
      }

      // Clave del mensaje: imprescindible para citarlo Y para volver a pedirle su
      // archivo a WhatsApp. En chats LID (número oculto) la librería no expone
      // `id._serialized`, así que se RECONSTRUYE (ver qrMessageId); antes se
      // guardaba solo el hash suelto y cualquier búsqueda por id fallaba con
      // "Invalid serialized message id specified".
      const serializedId = qrMessageId(msg);
      if (!serializedId) {
        console.warn(
          '[whatsapp-qr] mensaje entrante SIN wamid (no se podrá citar). type=%s from=%s id=%j',
          msg.type, from, msg.id
        );
      }

      // Anuncio click-to-WhatsApp (solo lo trae el 1er mensaje tras tocar el anuncio).
      const referral = extractQrReferral(msg);
      if (referral) {
        console.log('[ctwa_ad][qr] mensaje desde anuncio — source_id=%s url=%s de %s',
          referral.adId || '(vacío)', referral.sourceUrl || '(sin url)', from);
      } else if (msg._data && typeof msg._data === 'object') {
        // Sin mapear: si hay SEÑALES de anuncio (clave sospechosa arriba o dentro de
        // contextInfo) deja las claves reales en el log para ajustar el mapeo con
        // datos de producción (no se vuelca el cuerpo del mensaje, solo nombres).
        const adRe = /ctwa|ad_?reply|externalad|source_?url/i;
        const ci = msg._data.contextInfo;
        const ciObj = ci && typeof ci === 'object' ? ci : null;
        const topAdish = Object.keys(msg._data).some((k) => adRe.test(k));
        const ciAdish = ciObj && Object.keys(ciObj).some((k) => adRe.test(k));
        if (topAdish || ciAdish) {
          console.log('[ctwa_ad][qr] posible anuncio NO mapeado — _data:[%s] contextInfo:[%s]',
            Object.keys(msg._data).join(','), ciObj ? Object.keys(ciObj).join(',') : '—');
        }
      }

      const { ingestExternalMessage } = require('../controllers/chatController');
      await ingestExternalMessage({
        clinicId,
        channel: 'whatsapp',
        account: account2,
        phone,
        // JID completo (…@c.us / …@lid): imprescindible para RESPONDER a
        // contactos con número oculto (a un LID no se le puede escribir @c.us).
        externalUserId: from,
        body: bodyText,
        media,
        contactName: msg._data?.notifyName || '',
        externalId: serializedId,
        contextId,
        referral,
      });
    } catch (e) {
      console.error('[whatsapp-qr message]', e.message);
    }
  });

  // Mensaje SALIENTE creado (incluye los que el agente escribe desde el teléfono,
  // fuera del CRM). Solo nos interesan los `fromMe`: los entrantes ya los maneja
  // el evento 'message'. La ingesta deduplica los que envió el propio sistema.
  client.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe || msg.isStatus) return;
      const to = typeof msg.to === 'string' ? msg.to : '';
      if (!/@(c\.us|lid)$/.test(to)) return; // solo chats directos (no grupos)
      if (!CONTENT_TYPES.includes(msg.type)) return;
      // Mismo número real que en el entrante, para casar el saliente con SU chat.
      const phone = await resolveQrPhone(client, to);
      if (!phone) return;

      const media = await extractQrMedia(msg, client);
      if (!String(msg.body || '').trim() && !media) return;

      const account2 = await WhatsappAccount.findById(accountId);
      const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
      if (!clinicId) return;

      const serializedId = qrMessageId(msg);

      const { ingestExternalOutbound } = require('../controllers/chatController');
      await ingestExternalOutbound({
        clinicId,
        account: account2,
        phone,
        externalUserId: to,
        body: msg.body || '',
        media,
        externalId: serializedId,
        contactName: msg._data?.notifyName || '',
      });
    } catch (e) {
      console.error('[whatsapp-qr message_create]', e.message);
    }
  });

  // Confirmaciones de entrega de los mensajes salientes.
  client.on('message_ack', async (msg, ack) => {
    try {
      const status = ACK_STATUS[String(ack)];
      const externalId = qrMessageId(msg);
      if (!status || !externalId) return;
      const clinicId = await require('./callCenterClinic').resolveCallCenterClinicId();
      if (!clinicId) return;
      const messaging = require('./messaging');
      await messaging.updateMessageStatus({ clinicId, externalId, status });
    } catch { /* noop */ }
  });

  client.initialize().catch(async (e) => {
    const noChrome = /Could not find Chrome|Failed to launch/i.test(e.message || '');
    const short = noChrome
      ? 'Chromium no disponible en este entorno: los números QR no se conectarán aquí. Usa Cloud API, o un servidor con Chrome (VPS). Puedes fijar PUPPETEER_EXECUTABLE_PATH.'
      : (e.message || '').split('\n')[0];
    console.error('[whatsapp-qr initialize]', short);
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    clients.delete(key);
    try { await client.destroy(); } catch { /* noop */ }
    const fresh = await WhatsappAccount.findById(accountId).catch(() => null);
    if (fresh && !fresh.connectedPhone) await wipeLocalSession(sessionId);
    await setAccountStatus(accountId, { status: 'auth_failure' });
    await emitStatus(key, { status: 'auth_failure', error: short }, userId);
  });

  return { ok: true, status: 'connecting' };
}

/** Cierra la sesión de un número (logout) y limpia su estado. */
async function disconnect(accountId) {
  const key = String(accountId);
  const entry = clients.get(key);
  if (entry && entry.client) {
    if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
    if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
    try { await entry.client.logout(); } catch { /* noop */ }
    try { await entry.client.destroy(); } catch { /* noop */ }
  }
  clients.delete(key);
  syncRetries.delete(key);
  await setAccountStatus(accountId, { status: 'disconnected' });
  await emitStatus(key, { status: 'disconnected' });
  return { ok: true };
}

// sendMessage de whatsapp-web.js puede COLGARSE indefinidamente (p.ej. chatId
// inexistente): sin límite, la petición HTTP moría en 504 de nginx y el
// mensaje quedaba "en cola" para siempre.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(label)), ms).unref?.()),
  ]);
}

/**
 * Resuelve el chatId destino. JID completo si viene (…@c.us / …@lid, contactos
 * con número oculto); si solo hay dígitos, resolver el JID real con getNumberId —
 * valida que el número exista en WhatsApp y devuelve @c.us o @lid según
 * corresponda (un LID crudo enviado como @c.us se colgaba sin error).
 */
async function resolveChatId(entry, to) {
  let chatId = String(to || '').trim();
  if (!chatId) return { ok: false, error: 'Destino vacío' };
  if (!chatId.includes('@')) {
    const digits = chatId.replace(/[^\d]/g, '');
    if (!digits) return { ok: false, error: 'Teléfono inválido' };
    const numberId = await withTimeout(
      entry.client.getNumberId(digits),
      15000,
      'Tiempo agotado verificando el número en WhatsApp'
    );
    if (!numberId) {
      return { ok: false, errorCode: 'qr_invalid_number', error: `El número ${digits} no está en WhatsApp` };
    }
    chatId = numberId._serialized;
  }
  return { ok: true, chatId };
}

/**
 * Espera (hasta timeoutMs) a que la sesión termine de conectar. Tras un deploy
 * (pm2 restart) la sesión guardada tarda ~30-60 s en volver a 'connected';
 * los envíos de workflows que caían en esa ventana fallaban con "el número QR
 * no está conectado" aunque el número apareciera conectado minutos después.
 * Solo espera estados que se resuelven solos (connecting/syncing); si hace
 * falta escanear un QR o la sesión murió, devuelve null de inmediato.
 */
async function waitForConnected(key, timeoutMs = 45000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const entry = clients.get(key);
    if (entry && entry.status === 'connected') return entry;
    if (!entry || !['connecting', 'syncing'].includes(entry.status)) return null;
    if (Date.now() > until) return null;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Cura una entrada a 'connected' cuando la sesión resultó estar viva de verdad,
 * pero el estado cacheado se había quedado atrás. Desarma los watchdogs de
 * sincronización (si no, el destructivo podría cerrar una sesión que SÍ funciona)
 * y refleja el estado en la BD + la UI.
 */
function healToConnected(key, entry) {
  if (!entry || entry.status === 'connected') return;
  entry.status = 'connected';
  entry.percent = null;
  if (entry.syncWatchdog) { clearTimeout(entry.syncWatchdog); entry.syncWatchdog = null; }
  if (entry.watchdog) { clearTimeout(entry.watchdog); entry.watchdog = null; }
  const connectedPhone = (entry.client?.info?.wid?.user || '').toString();
  setAccountStatus(key, {
    status: 'connected',
    ...(connectedPhone ? { connectedPhone, lastConnectedAt: new Date() } : {}),
  }).catch(() => {});
  emitStatus(key, { status: 'connected', ...(connectedPhone ? { connectedPhone } : {}) }).catch(() => {});
  console.log(`[whatsappQr] estado curado a 'connected' para ${key} (la sesión estaba viva; getState=CONNECTED).`);
}

/**
 * Devuelve una entrada LISTA PARA ENVIAR, o null si de verdad no hay sesión.
 *
 * POR QUÉ: el estado cacheado (`entry.status`) NO es fiable. whatsapp-web.js
 * re-emite 'authenticated'/'loading_screen' al RE-SINCRONIZAR (tras reiniciar el
 * VPS, un bache de red, etc.) y deja el estado pegado en 'syncing'/'connecting'
 * aunque la sesión SÍ funcione — recibe mensajes y el teléfono envía, pero los
 * envíos del sistema fallaban con "el número QR no está conectado" y el chat
 * mostraba burbujas rojas con la sesión perfectamente viva. Antes de rendirnos,
 * preguntamos el estado REAL a la sesión (getState); si responde CONNECTED,
 * curamos el estado y enviamos igual.
 */
async function acquireSendableEntry(key) {
  let entry = clients.get(key);
  if (entry && entry.status === 'connected') return entry;
  if (entry && entry.client) {
    let live = null;
    try {
      live = await withTimeout(entry.client.getState(), 6000, '__timeout__');
    } catch (e) {
      // timeout = Chrome ocupado (no muerto): asumimos viva y dejamos que el envío,
      // con su propio timeout, decida. Otro error = sesión no consultable → null.
      live = String(e.message) === '__timeout__' ? 'CONNECTED' : null;
    }
    if (live === 'CONNECTED') {
      healToConnected(key, entry);
      return entry;
    }
  }
  // Sin veredicto de "conectado": si hay una sincronización en curso, espera a que
  // termine; si no, no está disponible.
  entry = await waitForConnected(key);
  return entry && entry.client && entry.status === 'connected' ? entry : null;
}

/**
 * Localiza DENTRO de la página de WhatsApp Web el mensaje a citar y devuelve su
 * id serializado REAL en el store (`{ id, step }`). NO usa los helpers de alto
 * nivel de whatsapp-web.js (getChatById/fetchMessages/getMessageById): esos
 * serializan modelos enteros (frágil) y exigen el id con la MISMA forma de JID
 * con que el store lo guardó — en chats LID (número oculto) el store puede
 * tener el mensaje bajo el número real (@c.us) aunque nosotros lo guardamos
 * como @lid, o al revés, y por eso "no se encontraba" ni un mensaje recién
 * enviado. Trabaja directo sobre el store con el mismo WWebJS.getChat del
 * envío normal (que sí funciona en estos chats). Estrategias, en orden:
 *   1) Msg.get(wamid) exacto.
 *   2) Por la parte ÚNICA del wamid (el hash), ignorando la forma del JID.
 *   3) Por TEXTO exacto del mensaje citado (cuando no hay wamid guardado).
 */
function findQuoteTargetId(entry, chatId, wamid, quoteBody) {
  return entry.client.pupPage.evaluate(async (chatId, wamid, body) => {
    // En chats LID el modelo del store puede NO exponer `id._serialized`
    // (probado en producción: se encontraba el mensaje por texto y el id salía
    // vacío). Se serializa de forma tolerante y, si hace falta, se reconstruye
    // a mano: fromMe_remoto_id[_participante].
    const widStr = (w) => {
      if (!w) return '';
      if (typeof w === 'string') return w;
      if (w._serialized) return String(w._serialized);
      if (w.user && w.server) return w.user + '@' + w.server;
      const s = typeof w.toString === 'function' ? w.toString() : '';
      return s && s !== '[object Object]' ? s : '';
    };
    const keyStr = (k) => {
      if (!k) return '';
      if (k._serialized) return String(k._serialized);
      const s = typeof k.toString === 'function' ? k.toString() : '';
      if (s && s !== '[object Object]') return s;
      const remote = widStr(k.remote);
      if (k.id && remote) {
        const part = widStr(k.participant);
        return (k.fromMe ? 'true' : 'false') + '_' + remote + '_' + k.id + (part ? '_' + part : '');
      }
      return '';
    };
    try {
      const Coll = window.require('WAWebCollections');
      // Devuelve el id del modelo encontrado, asegurando que el lookup que hará
      // whatsapp-web.js al citar (Msg.get global) lo pueda resolver.
      const finish = (m, step) => {
        const id = keyStr(m.id);
        if (!id) {
          const shape = m.id ? Object.keys(m.id).slice(0, 8).join(',') : 'sin_id';
          return { id: '', step: step + '_sin_serializar(' + shape + ')' };
        }
        let extra = '';
        if (!Coll.Msg.get(id)) {
          try { Coll.Msg.add(m); } catch (e) { /* colección no admite add */ }
          if (!Coll.Msg.get(id)) extra = '+fuera_del_store_global';
        }
        return { id, step: step + extra };
      };
      if (wamid) {
        const direct = Coll.Msg.get(wamid);
        if (direct && direct.id) return finish(direct, 'store');
      }
      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });
      if (!chat || !chat.msgs) return { id: '', step: 'chat_no_encontrado' };
      let msgs = chat.msgs.getModelsArray();
      try {
        const loader = window.require('WAWebChatLoadMessages');
        for (let i = 0; i < 5 && msgs.length < 50; i++) {
          const more = await loader.loadEarlierMsgs({ chat });
          if (!more || !more.length) break;
          msgs = chat.msgs.getModelsArray();
        }
      } catch (e) { /* seguir con lo que haya en memoria */ }
      // El hash es la 3ª parte del wamid (fromMe_remoto_HASH): idéntico en
      // ambas formas del JID.
      const hash = wamid ? String(wamid).split('_')[2] || '' : '';
      if (hash) {
        const byHash = msgs.filter((m) => m.id && m.id.id === hash);
        if (byHash.length) return finish(byHash[byHash.length - 1], 'hash');
      }
      const needle = String(body || '').trim();
      if (needle) {
        const byBody = msgs.filter((m) => String(m.body || '').trim() === needle);
        if (byBody.length) return finish(byBody[byBody.length - 1], 'texto');
      }
      return { id: '', step: 'sin_coincidencia(' + msgs.length + ' mensajes)' };
    } catch (e) {
      return { id: '', step: 'error:' + String((e && e.message) || e).slice(0, 120) };
    }
  }, chatId, wamid || '', quoteBody || '');
}

/**
 * Cuando WhatsApp Web envió el mensaje pero DESCARTÓ la cita en silencio,
 * pregunta dentro de la página el porqué (canReplyMsg / msgContextInfo). Es
 * solo diagnóstico: nunca lanza, devuelve un código corto.
 */
async function diagnoseQuoteDrop(entry, wamid) {
  if (!wamid) return 'sin_wamid';
  try {
    return await withTimeout(entry.client.pupPage.evaluate((mid) => {
      try {
        const m = window.require('WAWebCollections').Msg.get(mid);
        if (!m) return 'no_en_store';
        try {
          const R = window.require('WAWebMsgReply');
          const can = R && R.canReplyMsg
            ? !!R.canReplyMsg(m.unsafe ? m.unsafe() : m)
            : (typeof m.canReply === 'function' ? !!m.canReply() : null);
          if (can === false) return 'cannot_reply';
        } catch (e) { return 'canReply_error'; }
        if (typeof m.msgContextInfo !== 'function') return 'sin_msgContextInfo';
        return 'motivo_desconocido';
      } catch (e) { return 'eval_error'; }
    }, wamid), 8000, 'diagnose timeout');
  } catch (e) {
    return 'diagnose_timeout';
  }
}

/**
 * Envía `content` citando el mensaje indicado si se puede resolver (por wamid o
 * por texto). Si no, envía normal — nunca se pierde el mensaje. Devuelve
 * `{ sent, quote }` donde `quote` es el resultado REAL de la cita:
 *   { applied, how: 'id'|'text', reason, wamid }
 * `applied` se verifica DESPUÉS de enviar con `sent.hasQuotedMsg`: whatsapp-web.js
 * puede descartar la cita en silencio aun con el mensaje localizado (p.ej.
 * canReplyMsg=false), y esa era una caja negra — ahora queda registrado.
 */
async function sendResolvingQuote(entry, chatId, content, quotedMessageId, opts = {}, quoteBody = '') {
  const quote = { applied: false, how: '', reason: '', wamid: '' };
  if (quotedMessageId || String(quoteBody || '').trim()) {
    let found = { id: '', step: 'error:desconocido' };
    try {
      found = await withTimeout(
        findQuoteTargetId(entry, chatId, quotedMessageId, quoteBody),
        20000,
        'timeout buscando el mensaje a citar'
      );
    } catch (e) {
      found = { id: '', step: `error:${e.message}` };
    }
    if (found.id) {
      quote.how = found.step;
      quote.wamid = found.id;
      try {
        // El id encontrado es el REAL del store: Msg.get lo resolverá dentro de
        // la página. ignoreQuoteErrors:false → si aun así no lo localiza,
        // LANZA (default: manda normal en silencio) y aquí queda el motivo.
        const sent = await entry.client.sendMessage(chatId, content, {
          ...opts,
          quotedMessageId: found.id,
          ignoreQuoteErrors: false,
        });
        if (sent && sent.hasQuotedMsg === false) {
          quote.reason = `library_dropped:${await diagnoseQuoteDrop(entry, found.id)}`;
          console.warn('[whatsapp-qr quote] WhatsApp Web descartó la cita:', quote.reason);
        } else {
          quote.applied = true;
        }
        return { sent, quote };
      } catch (e) {
        quote.reason = `reply_error:${String(e.message || '').slice(0, 160)}`;
        console.warn('[whatsapp-qr quote] envío citando falló, se envía normal:', e.message);
      }
    } else {
      quote.reason = `not_found:${found.step}`;
      console.warn('[whatsapp-qr quote] mensaje a citar no localizado:', found.step);
    }
  }
  const sent = await entry.client.sendMessage(chatId, content, opts);
  return { sent, quote };
}

/** Envía texto por la sesión QR. Devuelve un shape compatible con messaging. */
async function sendText(account, to, body, quotedMessageId, quoteBody) {
  const key = String(account._id);
  const entry = await acquireSendableEntry(key);
  if (!entry) {
    return { ok: false, errorCode: 'qr_not_connected', error: 'El número QR no está conectado' };
  }
  try {
    const r = await resolveChatId(entry, to);
    if (!r.ok) return r;
    const { sent, quote } = await withTimeout(
      sendResolvingQuote(entry, r.chatId, String(body || '').slice(0, 4096), quotedMessageId, {}, quoteBody),
      50000,
      'Tiempo agotado enviando el mensaje (la sesión puede estar inestable)'
    );
    return {
      ok: true,
      data: { messages: [{ id: qrMessageId(sent) }] },
      ...(quotedMessageId || quoteBody ? { quote } : {}),
    };
  } catch (e) {
    return { ok: false, errorCode: 'qr_send_error', error: e.message };
  }
}

/**
 * ¿Salió de verdad el adjunto? Busca en el propio chat un mensaje NUESTRO con
 * media creado desde que empezó el envío y devuelve su wamid.
 *
 * whatsapp-web.js devuelve `undefined` cuando su colección interna todavía no
 * tiene el mensaje al terminar `sendMessage`, aunque ya lo haya encolado para
 * enviar — más probable cuanto más pesa el archivo. Sin esta comprobación el
 * video salía al contacto pero el sistema lo marcaba FALLIDO, y reintentarlo lo
 * enviaba DOS veces.
 */
async function findRecentlySentMedia(entry, chatId, startedAtMs) {
  // Margen por el desfase de reloj entre el servidor y WhatsApp Web.
  const sinceSec = Math.floor(startedAtMs / 1000) - 30;
  for (const wait of [1500, 3000]) {
    await sleep(wait);
    try {
      // eslint-disable-next-line no-await-in-loop
      const chat = await withTimeout(entry.client.getChatById(chatId), 15000, 'timeout abriendo el chat');
      // eslint-disable-next-line no-await-in-loop
      const msgs = await withTimeout(chat.fetchMessages({ limit: 8 }), 20000, 'timeout leyendo el chat');
      const mine = (msgs || []).filter((m) => m.fromMe && m.hasMedia && Number(m.timestamp || 0) >= sinceSec);
      const last = mine[mine.length - 1];
      const id = qrMessageId(last);
      if (id) return id;
    } catch (e) {
      console.warn('[wa-qr sendMedia] no se pudo verificar el envío en el chat: %s', e.message);
    }
  }
  return '';
}

/**
 * Escucha el evento `message_create` de la sesión mientras dura un envío y se
 * queda con el mensaje NUESTRO con adjunto que WhatsApp acaba de crear en ese
 * chat. Devuelve `{ id(), stop() }`.
 *
 * Es la confirmación MÁS fiable de que el adjunto salió: no busca nada por id ni
 * abre el chat (en los chats de número oculto, @lid, esas búsquedas fallan), sino
 * que escucha lo que la propia sesión anuncia. Sin esto, un envío que sí llegaba
 * al contacto se marcaba "no se envió" y al reintentarlo se mandaba dos veces.
 */
function watchOutgoingMedia(entry, chatId) {
  let found = '';
  const target = String(chatId || '');
  const onCreate = (m) => {
    try {
      if (found || !m?.fromMe || !m.hasMedia) return;
      const to = typeof m.to === 'string' ? m.to : widToString(m.to);
      if (to && target && to !== target) return;
      found = qrMessageId(m);
    } catch {
      /* noop */
    }
  };
  entry.client.on('message_create', onCreate);
  return {
    id: () => found,
    stop: () => {
      try { entry.client.off('message_create', onCreate); } catch { /* noop */ }
    },
  };
}

/**
 * Envía media (URL) con texto de pie por la sesión QR. Lo usan la cabecera de
 * imagen de las plantillas (por QR no existen plantillas de Meta: se manda la
 * imagen real con el cuerpo como caption), los adjuntos del compositor y las
 * notas de voz.
 *
 * `type` decide la forma del mensaje: con 'audio' se envía como NOTA DE VOZ
 * (sendAudioAsVoice) en vez de como archivo adjunto, igual que en la app.
 */
async function sendMedia(account, to, url, caption, type = 'image', quotedMessageId, quoteBody) {
  const key = String(account._id);
  const entry = await acquireSendableEntry(key);
  if (!entry) {
    return { ok: false, errorCode: 'qr_not_connected', error: 'El número QR no está conectado' };
  }
  const isVoice = type === 'audio';
  const isDoc = type === 'document';
  const isVideo = type === 'video';
  const what = isVoice ? 'la nota de voz' : isDoc ? 'el archivo' : isVideo ? 'el video' : 'la imagen';
  try {
    const r = await resolveChatId(entry, to);
    if (!r.ok) return r;
    // Bytes del adjunto: la URL autoalojada (/api/public/media/:id) se lee
    // directo de Mongo; una URL externa se descarga.
    let mime = isVoice ? 'audio/ogg' : 'image/jpeg';
    let b64 = '';
    let fileName = ''; // nombre real del documento (lo ve el contacto)
    const m = String(url || '').match(/\/api\/public\/media\/([a-f0-9]{24})/i);
    if (m) {
      const img = await require('../models/ChatGalleryImage').findById(m[1]).select('dataUrl mimeType name').lean();
      const parsed = require('./dataUrl').parseDataUrl(img?.dataUrl);
      if (!parsed) return { ok: false, error: `No se pudo leer ${what} guardado` };
      mime = parsed.mimeType || img.mimeType || mime;
      b64 = parsed.b64;
      fileName = img?.name || '';
    } else {
      const resp = await withTimeout(fetch(url), 20000, `Tiempo agotado descargando ${what}`);
      if (!resp.ok) return { ok: false, error: `No se pudo descargar ${what} (HTTP ${resp.status})` };
      mime = resp.headers.get('content-type') || mime;
      b64 = Buffer.from(await resp.arrayBuffer()).toString('base64');
    }
    if (!b64) {
      return { ok: false, errorCode: 'qr_media_unreadable', error: `No se pudo leer ${what} para enviarlo.` };
    }
    const { MessageMedia } = require('whatsapp-web.js');
    // El 3er argumento es el NOMBRE del archivo: un documento debe llevar el suyo
    // real (contrato.pdf) para que el contacto lo vea y lo pueda abrir.
    const mediaName = isVoice ? 'nota-de-voz.ogg' : isDoc ? (fileName || 'archivo') : isVideo ? (fileName || 'video.mp4') : 'imagen';
    const media = new MessageMedia(mime, b64, mediaName);
    // Nota de voz: sin pie. Documento: se fuerza a enviarse como ADJUNTO (no como
    // una vista previa) con `sendMediaAsDocument`, así llega con su nombre e icono.
    const opts = isVoice
      ? { sendAudioAsVoice: true }
      : isDoc
        ? { sendMediaAsDocument: true, caption: String(caption || '').slice(0, 1024) }
        : { caption: String(caption || '').slice(0, 1024) };
    const bytes = Math.floor(b64.length * 0.75);
    console.log('[wa-qr sendMedia] enviando kind=%s mime=%s bytes≈%d chat=%s', type, mime, bytes, r.chatId);
    // El tiempo de espera CRECE con el tamaño: un video de 10 MB tiene que
    // cifrarse y subirse desde el navegador headless, y con el minuto fijo de
    // antes los videos se marcaban fallidos a mitad de la subida.
    const sendTimeout = Math.min(300000, 60000 + Math.ceil(bytes / (1024 * 1024)) * 20000);
    // La cita se resuelve igual que en texto: getMessageById + reply() para que
    // el contacto vea el adjunto como respuesta al mensaje citado.
    const startedAt = Date.now();
    // Se empieza a escuchar ANTES de enviar: si la librería no devuelve el id, el
    // evento de la propia sesión confirma que el adjunto salió (ver watchOutgoingMedia).
    const watcher = watchOutgoingMedia(entry, r.chatId);
    let sent;
    let quote;
    try {
      ({ sent, quote } = await withTimeout(
        sendResolvingQuote(entry, r.chatId, media, quotedMessageId, opts, quoteBody),
        sendTimeout,
        `Tiempo agotado enviando ${what} (${Math.round(bytes / 1048576)} MB): la sesión puede estar inestable o la conexión es lenta`
      ));
    } catch (e) {
      // Aunque el envío "falle" por tiempo, WhatsApp puede haberlo mandado igual:
      // si la sesión anunció el mensaje, se da por enviado (y no se duplica).
      await sleep(1500);
      const late = watcher.id();
      watcher.stop();
      if (!late) throw e;
      console.warn('[wa-qr sendMedia] %s — pero la sesión SÍ creó el mensaje (wamid=%s)', e.message, late);
      return {
        ok: true,
        data: { messages: [{ id: late }] },
        ...(quotedMessageId || quoteBody ? { quote: { applied: false, how: '', reason: 'timeout', wamid: '' } } : {}),
      };
    }
    let wamid = qrMessageId(sent);
    if (!wamid) {
      // whatsapp-web.js devuelve `undefined` cuando, al terminar, el mensaje aún
      // no está en su colección interna — aunque YA lo haya puesto a enviar. Antes
      // se daba por fallido sin más: el video le llegaba al contacto y el chat lo
      // marcaba en rojo (y "Reintentar" lo enviaba DOS veces).
      console.warn('[wa-qr sendMedia] la sesión no devolvió wamid; verificando… chat=%s', r.chatId);
      await sleep(1500);
      wamid = watcher.id() || (await findRecentlySentMedia(entry, r.chatId, startedAt));
      if (!wamid) {
        watcher.stop();
        return {
          ok: false,
          errorCode: 'qr_media_unconfirmed',
          error: `WhatsApp no confirmó el envío de ${what} (la sesión puede estar inestable). Reintenta.`,
        };
      }
      console.log('[wa-qr sendMedia] confirmado por verificación wamid=%s', wamid);
    }
    watcher.stop();
    console.log('[wa-qr sendMedia] enviado OK wamid=%s en %ds', wamid, Math.round((Date.now() - startedAt) / 1000));
    return {
      ok: true,
      data: { messages: [{ id: wamid }] },
      ...(quotedMessageId || quoteBody ? { quote } : {}),
    };
  } catch (e) {
    return { ok: false, errorCode: 'qr_send_error', error: e.message };
  }
}

// La media entrante por QR llega inline (no se descarga por id): no-op.
async function downloadMedia() {
  return { ok: false };
}

/**
 * Vuelve a bajar el archivo de un mensaje que ya está en el chat, a partir de su
 * wamid. Lo usa el botón "Reintentar descarga" de la burbuja: el archivo sigue en
 * WhatsApp, así que un fallo puntual de la sesión no tiene por qué perderlo.
 */
async function redownloadMedia(account, serializedId) {
  if (!serializedId) return { ok: false, error: 'El mensaje no tiene identificador de WhatsApp.' };
  const entry = await acquireSendableEntry(String(account._id));
  if (!entry) return { ok: false, error: 'El número QR no está conectado.' };

  // Hash del mensaje: los mensajes guardados ANTES de reconstruir la clave (chats
  // @lid) tienen solo el hash, y `getMessageById` los rechaza con "Invalid
  // serialized message id specified". Con el hash se localizan igual en el store.
  const parts = String(serializedId).split('_');
  const hash = parts.length >= 3 ? parts[2] : String(serializedId);

  let msg = null;
  try {
    msg = await withTimeout(entry.client.getMessageById(serializedId), 15000, 'timeout buscando el mensaje');
  } catch {
    msg = null; // id no serializable: se va por la vía del navegador (abajo)
  }
  if (msg) {
    const media = await extractQrMedia(msg, entry.client, { retryDelays: [0, 1500, 3000] });
    if (media && media.dataUrl) {
      return { ok: true, dataUrl: media.dataUrl, size: media.size || 0, mediaName: media.filename || '' };
    }
  }

  const alt = await downloadQrMediaInPage(entry.client, parts.length >= 3 ? serializedId : '', hash);
  if (alt.ok && alt.data) {
    const bytes = Math.floor(alt.data.length * 0.75);
    if (bytes > MAX_QR_MEDIA_BYTES) return { ok: false, error: 'El archivo es demasiado grande para guardarlo.' };
    return {
      ok: true,
      dataUrl: `data:${cleanMime(alt.mimetype, 'application/octet-stream')};base64,${alt.data}`,
      size: bytes,
      mediaName: alt.filename || '',
    };
  }
  return { ok: false, error: alt.error || 'WhatsApp no entregó el archivo.' };
}

/** Estado vivo de un número (para la UI / endpoints). */
function getLiveStatus(accountId) {
  return clients.get(String(accountId))?.status || null;
}

/**
 * Foto del estado vivo para el sondeo HTTP del modal de conexión: estado, el
 * último QR generado y el % de sincronización. Devuelve null si no hay cliente.
 */
function getLiveSnapshot(accountId) {
  const entry = clients.get(String(accountId));
  if (!entry) return null;
  return { status: entry.status, qr: entry.lastQr || '', percent: entry.percent ?? null };
}

/**
 * Reconcilia el estado guardado de una cuenta QR con la realidad, mutando
 * `doc.status`. Se usa al listar los números para que la página nunca muestre
 * "conectado" con una sesión muerta:
 * - Sin cliente en memoria → cualquier estado activo en BD es viejo → 'disconnected'.
 * - Cliente 'connected' → verificación rápida con getState (2.5s de presupuesto;
 *   si no responde a tiempo se deja como está y el chequeo periódico decide).
 * - Cliente pegado en 'syncing'/'connecting' pero VIVO (getState=CONNECTED) → se
 *   CURA a 'connected'. Así la lista y los envíos coinciden con la realidad.
 */
async function reconcileAccount(doc) {
  const key = String(doc._id);
  const entry = clients.get(key);
  if (!entry) {
    if (['connected', 'connecting', 'qr_pending', 'syncing'].includes(doc.status)) {
      doc.status = 'disconnected';
      await WhatsappAccount.updateOne({ _id: doc._id }, { status: 'disconnected' }).catch(() => {});
    }
    return doc;
  }
  if (entry.status === 'connected') {
    doc.status = await verifyConnected(key, entry, 2500).catch(() => entry.status);
  } else if (entry.client && ['syncing', 'connecting'].includes(entry.status)) {
    let live = null;
    try {
      live = await withTimeout(entry.client.getState(), 2500, '__timeout__');
    } catch {
      live = null;
    }
    if (live === 'CONNECTED') healToConnected(key, entry);
    doc.status = entry.status;
  } else {
    doc.status = entry.status;
  }
  return doc;
}

/** Reconecta al arrancar el server los números QR habilitados con sesión guardada. */
async function initEnabledOnBoot() {
  try {
    const accounts = await WhatsappAccount.find({ connectionType: 'qr', enabled: true });
    for (const acc of accounts) {
      // Solo cuentas que COMPLETARON una vinculación (connectedPhone se guarda en
      // 'ready'). Tener solo sessionId significa que hubo un intento fallido: si
      // se conecta al boot, queda un cliente zombi mostrando QRs que nadie ve.
      if (!acc.sessionId || !acc.connectedPhone) continue;
      // eslint-disable-next-line no-await-in-loop
      await connect(acc._id).catch(() => {});
    }
  } catch (e) {
    console.error('[whatsapp-qr boot]', e.message);
  }
}

/**
 * Apagado ordenado del proceso (pm2 manda SIGINT en cada deploy): cierra TODOS
 * los Chromium con destroy() para que la sesión de WhatsApp se termine de
 * escribir en disco. Matarlos a lo bruto a mitad de escritura era lo que, tras
 * varios deploys seguidos, corrompía la sesión guardada y acababa en
 * auth_failure (tocaba re-escanear el QR). NO toca el estado en BD: al arrancar,
 * initEnabledOnBoot reconecta desde la sesión guardada.
 */
async function shutdownAll() {
  const entries = [...clients.values()];
  clients.clear();
  await Promise.allSettled(
    entries.map((e) => {
      if (e.watchdog) clearTimeout(e.watchdog);
      if (e.syncWatchdog) clearTimeout(e.syncWatchdog);
      return e.client.destroy().catch(() => {});
    })
  );
}

module.exports = {
  connect,
  disconnect,
  sendText,
  sendMedia,
  downloadMedia,
  redownloadMedia,
  getLiveStatus,
  getLiveSnapshot,
  reconcileAccount,
  initEnabledOnBoot,
  shutdownAll,
  // Solo para pruebas: acceso al mapa de sesiones y a la recuperación de estado.
  __test: {
    clients, acquireSendableEntry, healToConnected, extractQrMedia, describeQrNonMedia,
    findRecentlySentMedia, watchOutgoingMedia, qrMessageId, qrMessageHash, serializeMsgKey,
  },
};
