/**
 * Piezas comunes del «Conectar con…» (OAuth) y de las URLs públicas que las redes
 * necesitan para llegar a nuestro servidor.
 *
 * El flujo abre la pantalla de permisos de la red en una VENTANA EMERGENTE. La red
 * vuelve a `/api/social/oauth/<red>/callback` (ruta pública, sin sesión: quien
 * llega es el navegador redirigido por la red). Para saber quién lo pidió va un
 * `state` firmado con JWT_SECRET y caducidad corta. El callback responde una
 * página mínima que avisa a la ventana principal (postMessage) y se cierra; así
 * no hace falta conocer la URL del frontend.
 */
const jwt = require('jsonwebtoken');
const { SocialApiError } = require('./http');

/** URL pública de la API, terminada en /api (PUBLIC_API_URL). */
function apiBase() {
  const raw = String(process.env.PUBLIC_API_URL || '').trim().replace(/\/+$/, '');
  if (!raw) {
    throw new SocialApiError(
      'Falta PUBLIC_API_URL en el servidor: las redes necesitan una URL pública para volver y para descargar los medios.'
    );
  }
  return /\/api$/.test(raw) ? raw : `${raw}/api`;
}

/** URL de vuelta que se registra en el panel de cada red. */
function redirectUri(network) {
  return `${apiBase()}/social/oauth/${network}/callback`;
}

/** URLs de vuelta para enseñar en Configuración ('' si falta PUBLIC_API_URL). */
function redirectUris() {
  try {
    return { meta: redirectUri('meta'), tiktok: redirectUri('tiktok'), youtube: redirectUri('youtube') };
  } catch {
    return { meta: '', tiktok: '', youtube: '' };
  }
}

function signState({ userId, clinicId, network, extra = {} }) {
  return jwt.sign({ p: 'social_oauth', u: String(userId), c: String(clinicId), n: network, ...extra }, process.env.JWT_SECRET, {
    expiresIn: '20m',
  });
}

function verifyState(state, network) {
  try {
    const data = jwt.verify(String(state || ''), process.env.JWT_SECRET);
    if (data.p !== 'social_oauth' || data.n !== network) return null;
    return data;
  } catch {
    return null;
  }
}

const escapeHtml = (s) =>
  String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Página que devuelve el callback: avisa a la ventana que abrió el popup y se cierra. */
function callbackHtml({ ok, network, message }) {
  const payload = JSON.stringify({ type: 'social-oauth', ok: Boolean(ok), network, message: String(message || '') })
    .replace(/</g, '\\u003c');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conexión</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc;color:#0f172a}
.box{max-width:420px;padding:24px;text-align:center}.ok{color:#047857}.err{color:#be123c}</style></head>
<body><div class="box"><h2 class="${ok ? 'ok' : 'err'}">${ok ? 'Cuenta conectada' : 'No se pudo conectar'}</h2>
<p>${escapeHtml(message)}</p><p style="color:#64748b;font-size:13px">Ya puedes cerrar esta ventana.</p></div>
<script>try{if(window.opener){window.opener.postMessage(${payload},'*');setTimeout(function(){window.close()},1200)}}catch(e){}</script>
</body></html>`;
}

module.exports = { apiBase, callbackHtml, redirectUri, redirectUris, signState, verifyState };
