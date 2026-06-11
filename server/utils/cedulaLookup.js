/**
 * Consulta de datos de una persona por su cédula ecuatoriana.
 *
 * Fuente: servicio público del SRI (catastro de contribuyentes). Para una cédula
 * de persona natural, el RUC es la cédula + "001". El endpoint devuelve la
 * `razonSocial` en formato "APELLIDOS NOMBRES".
 *
 * Limitaciones (datos NO disponibles en fuentes públicas gratuitas en Ecuador):
 *   - Fecha de nacimiento / edad
 *   - Género
 * El Registro Civil no expone esos datos de forma libre. Solo obtenemos el nombre
 * completo, y únicamente si la persona tiene RUC registrado en el SRI. Para los
 * casos sin RUC el servicio no devuelve nombre y el usuario los ingresa a mano.
 */

const SRI_BASE =
  'https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest/ConsolidadoContribuyente/obtenerPorNumerosRuc';
const TIMEOUT_MS = 8000;

/**
 * Valida una cédula ecuatoriana (10 dígitos) con el algoritmo de dígito
 * verificador (módulo 10) y rango de provincia.
 */
function validateCedula(cedula) {
  const ced = String(cedula || '').trim();
  if (!/^\d{10}$/.test(ced)) return false;
  const province = parseInt(ced.slice(0, 2), 10);
  if (province < 1 || (province > 24 && province !== 30)) return false; // 30 = exterior
  const digits = ced.split('').map(Number);
  const verifier = digits[9];
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let val = digits[i] * (i % 2 === 0 ? 2 : 1);
    if (val > 9) val -= 9;
    sum += val;
  }
  const computed = (10 - (sum % 10)) % 10;
  return computed === verifier;
}

/**
 * Separa "APELLIDOS NOMBRES" (formato del SRI) en apellidos y nombres.
 * Convención ecuatoriana: 2 apellidos primero, luego los nombres. Es heurístico
 * (el SRI no separa los campos), por eso el usuario siempre puede corregir.
 */
function splitName(razonSocial) {
  const tokens = String(razonSocial || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  if (tokens.length === 0) return { firstName: '', lastName: '' };
  if (tokens.length === 1) return { firstName: tokens[0], lastName: '' };
  if (tokens.length === 2) return { lastName: tokens[0], firstName: tokens[1] };
  // 3+ tokens: asumimos 2 apellidos + el resto nombres.
  return {
    lastName: tokens.slice(0, 2).join(' '),
    firstName: tokens.slice(2).join(' '),
  };
}

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

/**
 * Devuelve { found, cedula, fullName, firstName, lastName, taxpayerState } o
 * lanza un Error con mensaje legible si la cédula es inválida.
 */
async function lookupCedula(cedula) {
  const ced = String(cedula || '').trim();
  if (!validateCedula(ced)) {
    const err = new Error('Cédula inválida');
    err.code = 'INVALID_CEDULA';
    throw err;
  }

  const { signal, clear } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(`${SRI_BASE}?ruc=${ced}001`, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal,
    });
    if (!res.ok) return { found: false, cedula: ced };
    const data = await res.json().catch(() => null);
    const record = Array.isArray(data) ? data[0] : null;
    const razonSocial = record?.razonSocial?.trim();
    if (!razonSocial) return { found: false, cedula: ced };
    const { firstName, lastName } = splitName(razonSocial);
    return {
      found: true,
      cedula: ced,
      fullName: razonSocial,
      firstName,
      lastName,
      taxpayerState: record?.estadoContribuyenteRuc || '',
    };
  } catch (e) {
    // Timeout / red / WAF: degradamos a "no encontrado" para no romper el alta.
    return { found: false, cedula: ced, error: 'lookup_failed' };
  } finally {
    clear();
  }
}

module.exports = { validateCedula, splitName, lookupCedula };
