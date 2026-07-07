/**
 * Validación de correos electrónicos en dos niveles (paralelo a cédula/RUC):
 *   - Offline: formato sintáctico (como el dígito verificador de la cédula).
 *   - Online: el DOMINIO realmente recibe correo (registros MX/A en DNS), como
 *     la consulta al SRI. Además sugiere correcciones de errores comunes de
 *     tipeo (gmail.con → gmail.com) y marca dominios desechables/temporales.
 *
 * NO se verifica el buzón exacto por SMTP: los servidores serios lo bloquean
 * (greylisting) y hacerlo puede marcar la IP como spam. Con formato + MX +
 * sugerencia se atrapan la enorme mayoría de errores reales.
 */

const dns = require('dns').promises;

// Formato: sin espacios, un @, dominio con al menos un punto y TLD de 2+ letras.
// No pretende cubrir el RFC completo (que acepta cosas que ningún proveedor usa),
// sino los correos reales. Longitud máxima 254 (límite del estándar).
const EMAIL_RE = /^(?!.*\.\.)[A-Za-z0-9._%+-]+@(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}$/;

// Dominios populares para sugerir correcciones de tipeo.
const POPULAR_DOMAINS = [
  'gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'yahoo.es',
  'hotmail.es', 'outlook.es', 'live.com', 'icloud.com', 'me.com',
  'protonmail.com', 'proton.me', 'aol.com', 'gmx.com',
];

// Dominios desechables/temporales frecuentes (lista corta, no exhaustiva).
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'tempmail.com', 'temp-mail.org', '10minutemail.com',
  'guerrillamail.com', 'yopmail.com', 'trashmail.com', 'sharklasers.com',
  'getnada.com', 'nada.email', 'throwawaymail.com', 'fakeinbox.com',
  'maildrop.cc', 'dispostable.com', 'mytemp.email', 'moakt.com',
]);

const TIMEOUT_MS = 5000;

function validateEmailFormat(email) {
  const e = String(email || '').trim();
  return e.length <= 254 && EMAIL_RE.test(e);
}

// Distancia de edición (Levenshtein) para detectar typos de dominio.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[m][n];
}

/**
 * Sugiere una corrección del correo si el dominio se parece mucho a uno popular
 * (distancia 1-2), p. ej. "gmail.con", "hotmial.com". Devuelve el correo
 * corregido o null.
 */
function suggestEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return null;
  const local = e.slice(0, at);
  const domain = e.slice(at + 1);
  if (!domain || POPULAR_DOMAINS.includes(domain)) return null;
  let best = null;
  let bestDist = Infinity;
  for (const d of POPULAR_DOMAINS) {
    const dist = levenshtein(domain, d);
    if (dist < bestDist) {
      bestDist = dist;
      best = d;
    }
  }
  if (best && bestDist > 0 && bestDist <= 2) return `${local}@${best}`;
  return null;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('dns_timeout')), ms)),
  ]);
}

/** ¿El dominio tiene servidores de correo (MX) o al menos un registro A/AAAA? */
async function domainHasMail(domain) {
  try {
    const mx = await withTimeout(dns.resolveMx(domain), TIMEOUT_MS);
    if (Array.isArray(mx) && mx.length > 0) return true;
  } catch (e) {
    // Sin MX o error: probamos A/AAAA (algunos dominios reciben por el A).
  }
  try {
    const a = await withTimeout(dns.resolve(domain), TIMEOUT_MS).catch(() => []);
    if (Array.isArray(a) && a.length > 0) return true;
  } catch (e) {
    /* noop */
  }
  return false;
}

/**
 * Verifica un correo. Devuelve:
 *   { valid, format, hasMx, disposable, domain, suggestion, reason }
 * `valid` es true solo si el formato es correcto, el dominio recibe correo y no
 * es desechable.
 */
async function checkEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  const suggestion = suggestEmail(e);
  if (!validateEmailFormat(e)) {
    return { valid: false, format: false, hasMx: false, disposable: false, suggestion, reason: 'format' };
  }
  const domain = e.slice(e.lastIndexOf('@') + 1);
  const disposable = DISPOSABLE_DOMAINS.has(domain);
  const hasMx = await domainHasMail(domain);
  return {
    valid: hasMx && !disposable,
    format: true,
    hasMx,
    disposable,
    domain,
    suggestion,
    reason: !hasMx ? 'no_mx' : disposable ? 'disposable' : 'ok',
  };
}

module.exports = { validateEmailFormat, suggestEmail, checkEmail };
