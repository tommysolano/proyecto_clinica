/**
 * Consulta de datos de una persona/empresa por su cédula o RUC ecuatoriano.
 *
 * Fuente: servicio público del SRI (catastro de contribuyentes).
 *   - Cédula (10 dígitos, persona natural): el RUC es la cédula + "001".
 *   - RUC (13 dígitos): se consulta tal cual (persona natural, sociedad o
 *     sector público).
 * El endpoint `obtenerPorNumerosRuc` devuelve la `razonSocial` (para persona
 * natural en formato "APELLIDOS NOMBRES"), el tipo y estado del contribuyente.
 * Un segundo endpoint (`Establecimiento/consultarPorNumeroRuc`) devuelve la
 * dirección de la matriz.
 *
 * Limitaciones (datos NO disponibles en fuentes públicas gratuitas en Ecuador):
 *   - Fecha de nacimiento / edad
 *   - Género
 * El Registro Civil no expone esos datos de forma libre. Para las personas sin
 * RUC registrado el servicio no devuelve nombre y el usuario los ingresa a mano.
 */

const SRI_REST =
  'https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest';
const SRI_CONSOLIDADO = `${SRI_REST}/ConsolidadoContribuyente/obtenerPorNumerosRuc`;
const SRI_ESTABLECIMIENTOS = `${SRI_REST}/Establecimiento/consultarPorNumeroRuc`;
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
 * Valida un RUC ecuatoriano (13 dígitos) según el tercer dígito:
 *   - 0-5: persona natural  → los 10 primeros dígitos son una cédula válida.
 *   - 6:   sector público   → verificador módulo 11 (coef. [3,2,7,6,5,4,3,2]).
 *   - 9:   sociedad privada → verificador módulo 11 (coef. [4,3,2,7,6,5,4,3,2]).
 * En todos los casos el sufijo de establecimiento debe ser >= 1.
 */
function validateRuc(ruc) {
  const r = String(ruc || '').trim();
  if (!/^\d{13}$/.test(r)) return false;
  const province = parseInt(r.slice(0, 2), 10);
  if (province < 1 || (province > 24 && province !== 30)) return false;
  const digits = r.split('').map(Number);
  const third = digits[2];

  // Persona natural con RUC: los 10 primeros son una cédula válida.
  if (third >= 0 && third <= 5) {
    if (!validateCedula(r.slice(0, 10))) return false;
    return parseInt(r.slice(10), 10) >= 1;
  }

  // Sector público: dígito verificador en la posición 9 (índice 8).
  if (third === 6) {
    const coef = [3, 2, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 8; i++) sum += digits[i] * coef[i];
    let ver = 11 - (sum % 11);
    if (ver === 11) ver = 0;
    if (ver === 10 || ver !== digits[8]) return false;
    return parseInt(r.slice(9), 10) >= 1; // establecimiento (0001+)
  }

  // Sociedad privada / extranjero: dígito verificador en la posición 10 (índice 9).
  if (third === 9) {
    const coef = [4, 3, 2, 7, 6, 5, 4, 3, 2];
    let sum = 0;
    for (let i = 0; i < 9; i++) sum += digits[i] * coef[i];
    let ver = 11 - (sum % 11);
    if (ver === 11) ver = 0;
    if (ver === 10 || ver !== digits[9]) return false;
    return parseInt(r.slice(10), 10) >= 1; // establecimiento (001+)
  }

  return false;
}

/** true si el texto es una cédula (10) o RUC (13) válido. */
function validateTaxId(id) {
  const v = String(id || '').trim();
  if (/^\d{10}$/.test(v)) return validateCedula(v);
  if (/^\d{13}$/.test(v)) return validateRuc(v);
  return false;
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

async function fetchJson(url) {
  const { signal, clear } = withTimeout(TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' },
      signal,
    });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch (e) {
    // Timeout / red / WAF: degradamos a null para no romper el alta.
    return null;
  } finally {
    clear();
  }
}

/** Dirección de la matriz del contribuyente (best-effort). */
async function fetchMatrizAddress(ruc) {
  const data = await fetchJson(`${SRI_ESTABLECIMIENTOS}?numeroRuc=${ruc}`);
  if (!Array.isArray(data) || data.length === 0) return '';
  const matriz = data.find((e) => e?.matriz === 'SI') || data[0];
  return (matriz?.direccionCompleta || '').trim();
}

/**
 * Consulta el SRI por cédula (10) o RUC (13). Devuelve
 * { found, cedula, ruc, fullName, firstName, lastName, isCompany,
 *   taxpayerType, taxpayerState, commercialName, mainActivity, address }
 * o lanza un Error (code INVALID_CEDULA) si el número es inválido.
 */
async function lookupTaxId(id) {
  const raw = String(id || '').trim();
  let ruc;
  if (/^\d{10}$/.test(raw)) {
    if (!validateCedula(raw)) {
      const err = new Error('Cédula inválida');
      err.code = 'INVALID_CEDULA';
      throw err;
    }
    ruc = `${raw}001`;
  } else if (/^\d{13}$/.test(raw)) {
    if (!validateRuc(raw)) {
      const err = new Error('RUC inválido');
      err.code = 'INVALID_CEDULA';
      throw err;
    }
    ruc = raw;
  } else {
    const err = new Error('Cédula o RUC inválido');
    err.code = 'INVALID_CEDULA';
    throw err;
  }

  // Consolidado (nombre/estado) y dirección de la matriz en paralelo.
  const [consolidado, address] = await Promise.all([
    fetchJson(`${SRI_CONSOLIDADO}?ruc=${ruc}`),
    fetchMatrizAddress(ruc),
  ]);

  const record = Array.isArray(consolidado) ? consolidado[0] : null;
  const razonSocial = record?.razonSocial?.trim();
  if (!razonSocial) return { found: false, cedula: raw, ruc };

  const isCompany = (record.tipoContribuyente || '').toUpperCase().includes('SOCIEDAD');
  const { firstName, lastName } = splitName(razonSocial);

  return {
    found: true,
    cedula: raw,
    ruc,
    fullName: razonSocial,
    // Para una sociedad el nombre es comercial: lo dejamos completo en apellidos
    // (no tiene sentido separar "nombres/apellidos").
    firstName: isCompany ? '' : firstName,
    lastName: isCompany ? razonSocial : lastName,
    isCompany,
    taxpayerType: record.tipoContribuyente || '',
    taxpayerState: record.estadoContribuyenteRuc || '',
    commercialName: '',
    mainActivity: record.actividadEconomicaPrincipal || '',
    address: address || '',
  };
}

module.exports = {
  validateCedula,
  validateRuc,
  validateTaxId,
  splitName,
  lookupTaxId,
  // Alias retrocompatible.
  lookupCedula: lookupTaxId,
};
