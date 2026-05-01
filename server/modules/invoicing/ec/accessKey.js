/**
 * Generación y validación de la Clave de Acceso del SRI (49 dígitos).
 *
 * Estructura:
 *   ddmmaaaa (8) + tipoComprobante (2) + ruc (13) + tipoAmbiente (1) +
 *   serie estab+ptoEmi (6) + secuencial (9) + codigoNumerico (8) +
 *   tipoEmision (1) + dígitoVerificador módulo 11 (1)
 *
 *   Total = 49 dígitos
 */

const TIPO_COMPROBANTE = {
  factura: '01',
  notaCredito: '04',
  notaDebito: '05',
  guiaRemision: '06',
  comprobanteRetencion: '07',
};

/**
 * Calcula el dígito verificador con el algoritmo módulo 11 de la SRI.
 * Pesos: 2,3,4,5,6,7 cíclicos de derecha a izquierda.
 */
function modulo11(digits) {
  const weights = [2, 3, 4, 5, 6, 7];
  let sum = 0;
  let w = 0;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += parseInt(digits[i], 10) * weights[w];
    w = (w + 1) % weights.length;
  }
  const mod = sum % 11;
  const verifier = 11 - mod;
  if (verifier === 11) return 0;
  if (verifier === 10) return 1;
  return verifier;
}

function pad(n, len) {
  return String(n).padStart(len, '0');
}

/**
 * @param {Object} params
 * @param {Date|string} params.fechaEmision   - fecha del documento
 * @param {string} params.tipoComprobante     - 'factura' | clave en TIPO_COMPROBANTE | código de 2 dígitos
 * @param {string} params.ruc                 - RUC 13 dígitos del emisor
 * @param {string} params.ambiente            - '1' pruebas | '2' producción
 * @param {string} params.estab               - 3 dígitos
 * @param {string} params.puntoEmision        - 3 dígitos
 * @param {string|number} params.secuencial   - 9 dígitos
 * @param {string} [params.codigoNumerico]    - 8 dígitos (default aleatorio)
 * @param {string} [params.tipoEmision='1']   - '1' normal
 */
function generarClaveAcceso({
  fechaEmision,
  tipoComprobante,
  ruc,
  ambiente,
  estab,
  puntoEmision,
  secuencial,
  codigoNumerico,
  tipoEmision = '1',
}) {
  const date = fechaEmision instanceof Date ? fechaEmision : new Date(fechaEmision);
  const ddmmaaaa =
    pad(date.getDate(), 2) + pad(date.getMonth() + 1, 2) + date.getFullYear();

  const codDoc =
    TIPO_COMPROBANTE[tipoComprobante] || String(tipoComprobante).padStart(2, '0');

  if (!/^\d{13}$/.test(ruc)) throw new Error('RUC inválido (debe tener 13 dígitos)');
  if (ambiente !== '1' && ambiente !== '2') throw new Error('Ambiente inválido');

  const codigoNum =
    codigoNumerico && /^\d{1,8}$/.test(String(codigoNumerico))
      ? pad(codigoNumerico, 8)
      : pad(Math.floor(10000000 + Math.random() * 89999999), 8);

  const sin = [
    ddmmaaaa,
    codDoc,
    ruc,
    ambiente,
    pad(estab, 3),
    pad(puntoEmision, 3),
    pad(secuencial, 9),
    codigoNum,
    tipoEmision,
  ].join('');

  if (sin.length !== 48) {
    throw new Error(`Clave previa inválida, longitud ${sin.length} esperada 48`);
  }

  const dv = modulo11(sin);
  return sin + String(dv);
}

function validarClaveAcceso(clave) {
  if (!/^\d{49}$/.test(clave)) return false;
  const dv = modulo11(clave.substring(0, 48));
  return String(dv) === clave[48];
}

module.exports = { generarClaveAcceso, validarClaveAcceso, modulo11, TIPO_COMPROBANTE };
