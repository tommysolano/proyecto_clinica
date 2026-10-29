/**
 * Canal TikTok (Business Messaging API de TikTok API for Business, v1.3).
 *
 * Cómo encaja con la bandeja:
 *  - Cada chat de TikTok es una CONVERSACIÓN de TikTok: `Conversation.externalUserId`
 *    guarda el `conversation_id`, que es lo que exige el envío (recipient_type
 *    CONVERSATION). El usuario de TikTok no tiene teléfono.
 *  - La cuenta de empresa se autoriza por OAuth (tt_user). El `open_id` que
 *    devuelve el canje del código es el `business_id` de todas las llamadas.
 *    El access token dura ~24 h: se renueva solo con el refresh token (~1 año)
 *    cuando está a punto de caducar (ver `getValidAccessToken`).
 *  - Los avisos (webhook DIRECT_MESSAGE) se registran por API con app_id+secret
 *    (`registerWebhook`) y llegan firmados en la cabecera `TikTok-Signature`
 *    (`t=<ts>,s=<hmac>`; HMAC-SHA256 de `${t}.${cuerpo crudo}` con el app secret).
 *  - El esquema exacto del aviso no está publicado fuera del portal, así que NO
 *    se depende de él: del aviso solo se saca el conversation_id (y, si viene,
 *    el message_id) y los mensajes se leen de /business/message/content/list/,
 *    cuyo formato sí está documentado. Si esa lectura falla, se usa lo que
 *    traiga el propio aviso.
 *
 * TikTok reintenta el aviso hasta 72 h (entrega "al menos una vez"): el
 * ingreso deduplica por message_id (ver ingestExternalMessage).
 */
const crypto = require('crypto');
const CallCenterConfig = require('../models/CallCenterConfig');
const { encryptSecret, decryptSecret } = require('./secretCrypto');

const API_BASE = 'https://business-api.tiktok.com/open_api/v1.3';
// Margen para renovar el token antes de que caduque de verdad.
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
// Tolerancia del reloj al comprobar la firma (TikTok no fija una).
const SIGNATURE_TOLERANCE_S = 5 * 60;
// Sin message_id en el aviso, se ingresan los mensajes del contacto de estos
// últimos minutos (los anteriores ya entraron o son historial viejo).
const RECENT_WINDOW_MS = 15 * 60 * 1000;
const MAX_IMAGE_BYTES = 3 * 1024 * 1024; // límite de TikTok para subir imágenes

class TiktokApiError extends Error {
  constructor(message, { code, status, data } = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.data = data;
  }
}

// =================== Firma del webhook ===================

function parseSignatureHeader(header) {
  const out = {};
  for (const part of String(header || '').split(',')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

/**
 * Comprueba `TikTok-Signature`. Devuelve { ok, reason }.
 * `rawBody` debe ser el cuerpo EXACTO recibido (Buffer o string).
 */
function verifySignature({ rawBody, header, secret, now = Date.now() }) {
  if (!secret) return { ok: false, reason: 'app_secret_not_configured' };
  if (!header) return { ok: false, reason: 'missing_signature' };
  const { t, s } = parseSignatureHeader(header);
  if (!t || !s) return { ok: false, reason: 'malformed_signature' };
  const body = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody ?? '');
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(s).toLowerCase(), 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'bad_signature' };
  const ts = Number(t);
  if (Number.isFinite(ts) && Math.abs(now / 1000 - ts) > SIGNATURE_TOLERANCE_S) {
    return { ok: false, reason: 'stale_signature' };
  }
  return { ok: true };
}

// =================== Llamadas a la API ===================

/**
 * Llamada a TikTok API for Business. La API responde HTTP 200 también en los
 * errores: el resultado real va en `code` (0 = OK) y `message`.
 */
async function apiRequest({ method = 'GET', path, token, query, body, form }) {
  const url = new URL(`${API_BASE}${path}`);
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null || v === '') continue;
    // URLSearchParams codifica '+' como %2B (TikTok lo exige en conversation_id).
    url.searchParams.set(k, Array.isArray(v) ? JSON.stringify(v) : String(v));
  }
  const headers = {};
  if (token) headers['Access-Token'] = token;
  let payload;
  if (form) payload = form;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, { method, headers, body: payload, signal: AbortSignal.timeout(20000) });
  } catch (err) {
    throw new TiktokApiError(`No se pudo contactar con TikTok: ${err.message}`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data.code !== undefined && Number(data.code) !== 0)) {
    throw new TiktokApiError(data.message || `TikTok respondió ${res.status}`, {
      code: data.code,
      status: res.status,
      data,
    });
  }
  return data.data || {};
}

// =================== Configuración y tokens ===================

async function loadConfig(clinicId) {
  const cfg = await CallCenterConfig.findOne({ clinic: clinicId });
  return { doc: cfg, tiktok: cfg?.tiktok || null };
}

function plainCredentials(tiktok) {
  return {
    appId: String(tiktok?.appId || '').trim(),
    appSecret: tiktok?.appSecret ? decryptSecret(tiktok.appSecret) : '',
    accessToken: tiktok?.accessToken ? decryptSecret(tiktok.accessToken) : '',
    refreshToken: tiktok?.refreshToken ? decryptSecret(tiktok.refreshToken) : '',
    businessId: String(tiktok?.businessId || '').trim(),
  };
}

const secondsFromNow = (s) => (Number(s) > 0 ? new Date(Date.now() + Number(s) * 1000) : null);

/** Guarda en la config la respuesta del canje/renovación de token. */
async function storeTokens(clinicId, data) {
  const set = {
    'tiktok.accessToken': encryptSecret(String(data.access_token || '')),
    'tiktok.accessTokenExpiresAt': secondsFromNow(data.expires_in),
  };
  if (data.refresh_token) {
    set['tiktok.refreshToken'] = encryptSecret(String(data.refresh_token));
    set['tiktok.refreshTokenExpiresAt'] = secondsFromNow(data.refresh_token_expires_in);
  }
  if (data.open_id) set['tiktok.businessId'] = String(data.open_id);
  if (data.scope) set['tiktok.scope'] = String(data.scope);
  await CallCenterConfig.updateOne({ clinic: clinicId }, { $set: set }, { upsert: true });
}

/** Canjea el código de la pantalla de autorización de TikTok por tokens. */
async function exchangeAuthCode(clinicId, { authCode, redirectUri }) {
  const { tiktok } = await loadConfig(clinicId);
  const { appId, appSecret } = plainCredentials(tiktok);
  if (!appId || !appSecret) throw new TiktokApiError('Primero guarda el App ID y el App Secret.');
  const data = await apiRequest({
    method: 'POST',
    path: '/tt_user/oauth2/token/',
    body: {
      client_id: appId,
      client_secret: appSecret,
      grant_type: 'authorization_code',
      auth_code: authCode,
      redirect_uri: redirectUri,
    },
  });
  if (!data.access_token) throw new TiktokApiError('TikTok no devolvió el access token.', { data });
  await storeTokens(clinicId, data);
  await CallCenterConfig.updateOne({ clinic: clinicId }, { $set: { 'tiktok.authorizedAt': new Date() } });
  return data;
}

// Una renovación por clínica a la vez: si dos envíos piden token a la vez y
// TikTok rota el refresh token, el segundo canje fallaría con el ya usado.
const refreshing = new Map();

async function refreshAccessToken(clinicId) {
  const key = String(clinicId);
  if (refreshing.has(key)) return refreshing.get(key);
  const p = (async () => {
    const { tiktok } = await loadConfig(clinicId);
    const { appId, appSecret, refreshToken } = plainCredentials(tiktok);
    if (!appId || !appSecret || !refreshToken) {
      throw new TiktokApiError('El token de TikTok caducó y no hay refresh token: vuelve a conectar la cuenta.');
    }
    const data = await apiRequest({
      method: 'POST',
      path: '/tt_user/oauth2/refresh_token/',
      body: { client_id: appId, client_secret: appSecret, grant_type: 'refresh_token', refresh_token: refreshToken },
    });
    if (!data.access_token) throw new TiktokApiError('TikTok no devolvió un token nuevo.', { data });
    await storeTokens(clinicId, data);
    return String(data.access_token);
  })();
  refreshing.set(key, p);
  try {
    return await p;
  } finally {
    refreshing.delete(key);
  }
}

/** Token listo para usar (renovado si caduca en los próximos minutos). */
async function getValidAccessToken(clinicId) {
  const { tiktok } = await loadConfig(clinicId);
  const creds = plainCredentials(tiktok);
  if (!creds.accessToken) throw new TiktokApiError('La cuenta de TikTok no está conectada.');
  const expiresAt = tiktok?.accessTokenExpiresAt ? new Date(tiktok.accessTokenExpiresAt).getTime() : 0;
  if (expiresAt && expiresAt - Date.now() < REFRESH_MARGIN_MS && creds.refreshToken) {
    return { token: await refreshAccessToken(clinicId), businessId: creds.businessId };
  }
  return { token: creds.accessToken, businessId: creds.businessId };
}

/**
 * Ejecuta `fn(token, businessId)`; si TikTok rechaza el token (caducado o
 * revocado antes de lo previsto), renueva una vez y reintenta.
 */
async function withToken(clinicId, fn) {
  const { token, businessId } = await getValidAccessToken(clinicId);
  if (!businessId) throw new TiktokApiError('Falta el Business ID (open_id) de la cuenta de TikTok.');
  try {
    return await fn(token, businessId);
  } catch (err) {
    const msg = String(err.message || '').toLowerCase();
    const tokenProblem = err.status === 401 || /access.?token|token.*(expired|invalid)/.test(msg);
    if (!tokenProblem) throw err;
    const fresh = await refreshAccessToken(clinicId);
    return fn(fresh, businessId);
  }
}

// =================== Webhook (registro) ===================

async function registerWebhook(clinicId, callbackUrl) {
  const { tiktok } = await loadConfig(clinicId);
  const { appId, appSecret } = plainCredentials(tiktok);
  if (!appId || !appSecret) throw new TiktokApiError('Primero guarda el App ID y el App Secret.');
  const data = await apiRequest({
    method: 'POST',
    path: '/business/webhook/update/',
    body: { app_id: appId, secret: appSecret, event_type: 'DIRECT_MESSAGE', callback_url: callbackUrl },
  });
  await CallCenterConfig.updateOne(
    { clinic: clinicId },
    { $set: { 'tiktok.webhookCallbackUrl': data.callback_url || callbackUrl, 'tiktok.webhookRegisteredAt': new Date() } }
  );
  return data;
}

async function getWebhook(clinicId) {
  const { tiktok } = await loadConfig(clinicId);
  const { appId, appSecret } = plainCredentials(tiktok);
  if (!appId || !appSecret) throw new TiktokApiError('Falta el App ID o el App Secret.');
  return apiRequest({
    path: '/business/webhook/list/',
    query: { app_id: appId, secret: appSecret, event_type: 'DIRECT_MESSAGE' },
  });
}

// =================== Envío ===================

async function uploadImage({ token, businessId, mediaUrl }) {
  const res = await fetch(mediaUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new TiktokApiError(`No se pudo leer la imagen (${res.status}).`);
  const mime = String(res.headers.get('content-type') || '').split(';')[0];
  if (!/^image\/(jpe?g|png)$/i.test(mime)) throw new TiktokApiError('TikTok solo admite imágenes JPG o PNG.');
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > MAX_IMAGE_BYTES) throw new TiktokApiError('TikTok solo admite imágenes de hasta 3 MB.');
  const form = new FormData();
  form.append('business_id', businessId);
  form.append('media_type', 'IMAGE');
  form.append('file', new Blob([buffer], { type: mime }), mime.endsWith('png') ? 'imagen.png' : 'imagen.jpg');
  const data = await apiRequest({ method: 'POST', path: '/business/message/media/upload/', token, form });
  if (!data.media_id) throw new TiktokApiError('TikTok no devolvió el id de la imagen.', { data });
  return data.media_id;
}

/**
 * Envía a una conversación de TikTok. Texto (hasta 6.000 caracteres) e
 * imágenes JPG/PNG; con imagen y texto salen dos mensajes, como en Instagram.
 * Devuelve el formato de `sendToProvider`: { ok, data: { message_id } } o
 * { ok: false, errorCode, error }.
 */
async function sendMessage({ clinicId, conversationId, body, mediaUrl, mediaType, referencedMessageId }) {
  if (!conversationId) return { ok: false, errorCode: 'invalid_recipient', error: 'El chat no tiene conversación de TikTok.' };
  if (mediaUrl && mediaType !== 'image') {
    return { ok: false, errorCode: 'unsupported_media', error: 'Por TikTok solo se pueden enviar texto e imágenes.' };
  }
  const text = String(body || '').slice(0, 6000);
  if (!mediaUrl && !text) return { ok: false, errorCode: 'invalid_recipient', error: 'Mensaje vacío' };
  try {
    return await withToken(clinicId, async (token, businessId) => {
      const base = { business_id: businessId, recipient_type: 'CONVERSATION', recipient: conversationId };
      let lastId = '';
      if (mediaUrl) {
        const mediaId = await uploadImage({ token, businessId, mediaUrl });
        const r = await apiRequest({
          method: 'POST',
          path: '/business/message/send/',
          token,
          body: { ...base, message_type: 'IMAGE', image: { media_id: mediaId } },
        });
        lastId = r?.message?.message_id || '';
      }
      if (text) {
        const r = await apiRequest({
          method: 'POST',
          path: '/business/message/send/',
          token,
          body: {
            ...base,
            message_type: 'TEXT',
            text: { body: text },
            // Responder citando: TikTok solo lo admite en respuestas de texto.
            ...(referencedMessageId && !mediaUrl ? { referenced_message_info: { referenced_message_id: referencedMessageId } } : {}),
          },
        });
        lastId = r?.message?.message_id || lastId;
      }
      return { ok: true, data: { message_id: lastId } };
    });
  } catch (err) {
    return {
      ok: false,
      errorCode: err.code ? `tiktok_${err.code}` : 'provider_error',
      error: `TikTok: ${err.message}`,
    };
  }
}

// =================== Recepción ===================

const parseMaybeJson = (v) => {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
};

/**
 * Saca del aviso lo que haga falta, aceptando las formas conocidas de TikTok:
 * sobre { client_key, event, create_time, user_openid, content: "<json>" } o el
 * objeto del mensaje directamente. Devuelve null si no es un mensaje.
 */
function parseWebhookEvent(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const content = parseMaybeJson(payload.content);
  const candidates = [
    content?.message,
    Array.isArray(content?.messages) ? content.messages[0] : null,
    content,
    payload.message,
    payload.data?.message,
    payload.data,
    payload,
  ].filter((x) => x && typeof x === 'object');
  const msg = candidates.find((x) => x.conversation_id || x.message_id) || candidates[0] || {};
  const conversationId = String(msg.conversation_id || content?.conversation_id || payload.conversation_id || '').trim();
  if (!conversationId) return null;
  return {
    event: String(payload.event || payload.event_type || ''),
    businessId: String(payload.user_openid || content?.business_id || payload.business_id || ''),
    conversationId,
    messageId: String(msg.message_id || '').trim(),
    createTime: Number(payload.create_time) || null,
    message: msg,
  };
}

const ROLE_BUSINESS = 'BUSINESS_ACCOUNT';

/** Normaliza un mensaje de TikTok (formato de content/list) a lo que pide la bandeja. */
function normalizeMessage(m, participants = [], businessId = '') {
  const type = String(m.message_type || m.type || (m.text ? 'TEXT' : 'OTHER')).toUpperCase();
  const from = m.from_user || participants.find((p) => p.id && p.id === m.sender) || null;
  const fromBusiness = from?.role === ROLE_BUSINESS || (businessId && m.sender === businessId);
  let body = '';
  let media = null;
  switch (type) {
    case 'TEXT':
      body = String(m.text?.body || '');
      break;
    case 'IMAGE':
      media = { type: 'image', mediaId: m.image?.media_id || '' };
      break;
    case 'VIDEO':
      media = { type: 'video', mediaId: m.video?.media_id || '' };
      break;
    case 'STICKER':
      if (m.sticker?.url) media = { type: 'image', remoteUrl: m.sticker.url };
      else body = '🙂 Sticker';
      break;
    case 'EMOJI':
      if (m.emoji?.url) media = { type: 'image', remoteUrl: m.emoji.url };
      else body = '🙂 Emoji';
      break;
    case 'SHARE_POST':
      body = `🔗 Compartió una publicación${m.share_post?.embed_url ? `: ${m.share_post.embed_url}` : ''}`;
      break;
    case 'TEMPLATE':
      body = String(m.template?.title || '');
      break;
    default:
      body = '[Mensaje de TikTok no compatible: ábrelo en la app de TikTok]';
  }
  return {
    messageId: String(m.message_id || ''),
    conversationId: String(m.conversation_id || ''),
    timestamp: Number(m.timestamp) || null,
    fromBusiness: Boolean(fromBusiness),
    contactName: fromBusiness ? '' : String(from?.display_name || ''),
    body,
    media,
  };
}

async function listMessages(clinicId, conversationId) {
  return withToken(clinicId, async (token, businessId) => {
    const data = await apiRequest({
      path: '/business/message/content/list/',
      token,
      query: { business_id: businessId, conversation_id: conversationId },
    });
    const participants = Array.isArray(data.participants) ? data.participants : [];
    return (Array.isArray(data.messages) ? data.messages : []).map((m) => normalizeMessage(m, participants, businessId));
  });
}

/** Enlace temporal (24 h) para descargar una imagen o video recibido. */
async function mediaDownloadUrl(clinicId, { conversationId, messageId, mediaId, mediaType }) {
  return withToken(clinicId, async (token, businessId) => {
    const data = await apiRequest({
      method: 'POST',
      path: '/business/message/media/download/',
      token,
      body: {
        business_id: businessId,
        conversation_id: conversationId,
        message_id: messageId,
        media_id: mediaId,
        media_type: mediaType === 'video' ? 'VIDEO' : 'IMAGE',
      },
    });
    return data.download_url || '';
  });
}

/**
 * Mensajes del contacto que hay que ingresar por este aviso. Prefiere leerlos
 * de la API (formato documentado); si falla, usa lo que trae el aviso.
 */
async function messagesForEvent(clinicId, ev) {
  let fromApi = null;
  try {
    fromApi = await listMessages(clinicId, ev.conversationId);
  } catch (err) {
    console.warn('[tiktok] no se pudo leer la conversación %s: %s', ev.conversationId, err.message);
  }
  let picked = [];
  if (fromApi) {
    const inbound = fromApi.filter((m) => !m.fromBusiness && m.messageId);
    if (ev.messageId) picked = inbound.filter((m) => m.messageId === ev.messageId);
    if (!picked.length) {
      const since = (ev.createTime ? ev.createTime * 1000 : Date.now()) - RECENT_WINDOW_MS;
      picked = inbound.filter((m) => !m.timestamp || m.timestamp >= since);
    }
  }
  if (!picked.length) {
    const own = normalizeMessage({ conversation_id: ev.conversationId, ...ev.message }, [], ev.businessId);
    if (!own.fromBusiness && (own.body || own.media) && own.messageId) picked = [own];
  }
  return picked.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
}

/**
 * Procesa un aviso ya verificado. `ingest` es ingestExternalMessage (se inyecta
 * para no crear un ciclo de require con chatController).
 */
async function processWebhook(clinicId, payload, ingest) {
  const ev = parseWebhookEvent(payload);
  await CallCenterConfig.updateOne(
    { clinic: clinicId },
    { $set: { 'tiktok.lastEventAt': new Date(), 'tiktok.lastEventError': ev ? '' : 'Aviso sin conversation_id (ignorado)' } }
  ).catch(() => {});
  if (!ev) return { ingested: 0 };
  const messages = await messagesForEvent(clinicId, ev);
  for (const m of messages) {
    let media = null;
    if (m.media?.remoteUrl) media = { type: m.media.type, remoteUrl: m.media.remoteUrl };
    else if (m.media?.mediaId) {
      const url = await mediaDownloadUrl(clinicId, {
        conversationId: m.conversationId || ev.conversationId,
        messageId: m.messageId,
        mediaId: m.media.mediaId,
        mediaType: m.media.type,
      }).catch((err) => {
        console.warn('[tiktok] no se pudo obtener la media %s: %s', m.messageId, err.message);
        return '';
      });
      media = url ? { type: m.media.type, remoteUrl: url } : null;
    }
    await ingest({
      clinicId,
      channel: 'tiktok',
      externalUserId: m.conversationId || ev.conversationId,
      body: m.body || (m.media && !media ? (m.media.type === 'video' ? '🎥 Video (ábrelo en TikTok)' : '📷 Imagen (ábrela en TikTok)') : ''),
      contactName: m.contactName,
      externalId: m.messageId,
      media,
    });
  }
  return { ingested: messages.length };
}

/** Prueba real de la conexión: credenciales de la app, webhook y token de la cuenta. */
async function testConnection(clinicId) {
  const checks = [];
  try {
    const wh = await getWebhook(clinicId);
    checks.push({
      name: 'app',
      ok: true,
      message: wh?.callback_url ? `Webhook registrado en TikTok: ${wh.callback_url}` : 'App válida, pero el webhook aún no está registrado.',
      callbackUrl: wh?.callback_url || '',
    });
  } catch (err) {
    checks.push({ name: 'app', ok: false, message: `App ID / App Secret: ${err.message}` });
  }
  try {
    await withToken(clinicId, (token, businessId) =>
      apiRequest({
        path: '/business/message/conversation/list/',
        token,
        query: { business_id: businessId, conversation_type: 'SINGLE', limit: 1 },
      })
    );
    checks.push({ name: 'account', ok: true, message: 'Cuenta conectada: se pueden leer y enviar mensajes.' });
  } catch (err) {
    checks.push({ name: 'account', ok: false, message: `Cuenta de TikTok: ${err.message}` });
  }
  return checks;
}

module.exports = {
  API_BASE,
  TiktokApiError,
  verifySignature,
  parseWebhookEvent,
  normalizeMessage,
  exchangeAuthCode,
  refreshAccessToken,
  getValidAccessToken,
  registerWebhook,
  getWebhook,
  sendMessage,
  listMessages,
  processWebhook,
  testConnection,
};
