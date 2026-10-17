/**
 * Peticiones HTTP a las APIs de redes sociales con UN formato de error.
 *
 * Cada plataforma devuelve los errores a su manera (Meta: `error.code` +
 * `is_transient`; TikTok: `error.code` en texto; Google: `error.errors[].reason`).
 * Aquí se traducen a `SocialApiError` con dos datos que el publicador necesita:
 *   - `retryable`: ¿vale la pena reintentar en unos minutos? (caída, límite de
 *     velocidad, 5xx) o es un error de contenido/permisos que se repetiría igual.
 *   - `tokenInvalid`: el token ya no sirve → la cuenta pasa a «error» y hay que
 *     volver a conectarla.
 */
const fs = require('fs');
const https = require('https');
const { URL } = require('url');

class SocialApiError extends Error {
  constructor(message, { status = 0, code = '', retryable = false, tokenInvalid = false, raw = null } = {}) {
    super(message);
    this.name = 'SocialApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.tokenInvalid = tokenInvalid;
    this.raw = raw;
  }
}

// Meta: códigos que son momentáneos (límite de llamadas, servicio caído).
const META_RETRYABLE = new Set([1, 2, 4, 17, 32, 341, 613, 80001, 80002]);

function errorFromBody(status, body) {
  const e = body && typeof body === 'object' ? body.error : null;
  // Meta (Graph API)
  if (e && (e.fbtrace_id || e.type === 'OAuthException' || typeof e.code === 'number')) {
    const msg = e.error_user_msg || e.error_user_title || e.message || `Error ${status}`;
    return new SocialApiError(msg, {
      status,
      code: String(e.code || ''),
      retryable: Boolean(e.is_transient) || META_RETRYABLE.has(Number(e.code)) || status >= 500,
      tokenInvalid: Number(e.code) === 190 || Number(e.code) === 102,
      raw: body,
    });
  }
  // TikTok (open.tiktokapis.com): { error: { code: 'access_token_invalid', message } }
  if (e && typeof e.code === 'string' && e.code !== 'ok') {
    return new SocialApiError(e.message || e.code, {
      status,
      code: e.code,
      retryable: e.code === 'rate_limit_exceeded' || e.code === 'internal_error' || status >= 500,
      tokenInvalid: ['access_token_invalid', 'scope_not_authorized', 'token_not_authorized_for_specified_deployment'].includes(e.code),
      raw: body,
    });
  }
  // Google (YouTube / OAuth)
  if (e && typeof e === 'object') {
    const reason = e.errors?.[0]?.reason || e.status || '';
    return new SocialApiError(e.message || reason || `Error ${status}`, {
      status,
      code: String(reason),
      retryable: status >= 500 || reason === 'rateLimitExceeded' || reason === 'backendError',
      tokenInvalid: status === 401 || reason === 'authError',
      raw: body,
    });
  }
  // OAuth estándar: { error: 'invalid_grant', error_description }
  if (body && typeof body.error === 'string') {
    return new SocialApiError(body.error_description || body.error, {
      status,
      code: body.error,
      tokenInvalid: body.error === 'invalid_grant',
      raw: body,
    });
  }
  return new SocialApiError(`La red respondió ${status}`, { status, retryable: status >= 500 || status === 429, raw: body });
}

/**
 * fetch + JSON. `form` se manda como x-www-form-urlencoded; `json` como JSON.
 * Lanza SocialApiError si la respuesta no es 2xx (o si un 200 trae `error`).
 */
async function request(url, { method = 'GET', headers = {}, json, form, body, timeoutMs = 60000 } = {}) {
  const opts = { method, headers: { ...headers } };
  if (json !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=UTF-8';
    opts.body = JSON.stringify(json);
  } else if (form !== undefined) {
    opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    opts.body = new URLSearchParams(
      Object.entries(form).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, typeof v === 'object' ? JSON.stringify(v) : String(v)])
    ).toString();
  } else if (body !== undefined) {
    opts.body = body;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  opts.signal = ctrl.signal;
  let res;
  try {
    res = await fetch(url, opts);
  } catch (err) {
    throw new SocialApiError(
      err.name === 'AbortError' ? 'La red social tardó demasiado en responder' : `Sin conexión con la red social: ${err.message}`,
      { retryable: true }
    );
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw errorFromBody(res.status, data);
  // TikTok responde 200 con error.code = 'ok' cuando todo va bien.
  if (data && data.error && !(typeof data.error === 'object' && data.error.code === 'ok')) {
    throw errorFromBody(res.status, data);
  }
  return { data, headers: res.headers, status: res.status };
}

/**
 * Sube un tramo de un archivo del disco por STREAM (sin cargarlo en memoria).
 * fetch de Node no deja fijar Content-Length con un cuerpo en stream, y tanto
 * TikTok como YouTube lo exigen; por eso va con https a mano.
 */
function uploadFileRange(urlStr, { method = 'PUT', headers = {}, filePath, start = 0, end, timeoutMs = 15 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const length = end - start + 1;
    const req = https.request(
      {
        method,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, 'Content-Length': String(length) },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = {};
          try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
          if (res.statusCode >= 200 && res.statusCode < 300) return resolve({ status: res.statusCode, data, headers: res.headers });
          if (res.statusCode === 308) return resolve({ status: 308, data, headers: res.headers });
          return reject(errorFromBody(res.statusCode, data));
        });
      }
    );
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', (err) => reject(new SocialApiError(`Falló la subida del archivo: ${err.message}`, { retryable: true })));
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('error', (err) => req.destroy(err));
    stream.pipe(req);
  });
}

module.exports = { SocialApiError, request, uploadFileRange, errorFromBody };
