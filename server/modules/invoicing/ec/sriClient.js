/**
 * Cliente SOAP para los servicios web del SRI:
 *   - Recepción Comprobantes Offline
 *   - Autorización Comprobantes Offline
 */
const soap = require('soap');
const https = require('https');

const URLS = {
  pruebas: {
    recepcion:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    autorizacion:
      'https://celcer.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
  },
  produccion: {
    recepcion:
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/RecepcionComprobantesOffline?wsdl',
    autorizacion:
      'https://cel.sri.gob.ec/comprobantes-electronicos-ws/AutorizacionComprobantesOffline?wsdl',
  },
};

function ambienteToKey(ambiente) {
  return ambiente === '2' ? 'produccion' : 'pruebas';
}

const SOAP_OPTS = { disableCache: true, returnFault: true };
const TIMEOUT_MS = 30000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Timeout SRI tras ${ms}ms`)), ms)
    ),
  ]);
}

/**
 * Envía el XML firmado al servicio de Recepción.
 * @returns {Promise<{estado:string, comprobantes?:object}>}
 */
async function enviarComprobante(xmlFirmado, ambiente) {
  const url = URLS[ambienteToKey(ambiente)].recepcion;
  const client = await withTimeout(soap.createClientAsync(url, SOAP_OPTS), TIMEOUT_MS);
  const xmlBase64 = Buffer.from(xmlFirmado, 'utf8').toString('base64');
  const [result] = await withTimeout(
    client.validarComprobanteAsync({ xml: xmlBase64 }),
    TIMEOUT_MS
  );
  return result?.RespuestaRecepcionComprobante || result;
}

/**
 * Consulta la autorización de un comprobante por su clave de acceso.
 */
async function autorizarComprobante(claveAcceso, ambiente) {
  const url = URLS[ambienteToKey(ambiente)].autorizacion;
  const client = await withTimeout(soap.createClientAsync(url, SOAP_OPTS), TIMEOUT_MS);
  const [result] = await withTimeout(
    client.autorizacionComprobanteAsync({ claveAccesoComprobante: claveAcceso }),
    TIMEOUT_MS
  );
  return result?.RespuestaAutorizacionComprobante || result;
}

/**
 * ¿El error es de conectividad (SRI caído / red / timeout) en vez de un rechazo
 * de negocio? Distinguirlos es clave: los de conectividad se reintentan solos;
 * los de negocio (comprobante devuelto / no autorizado) requieren corrección.
 */
function isConnectivityError(err) {
  const code = String(err?.code || '').trim().toUpperCase();
  if (
    [
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ECONNRESET',
      'EAI_AGAIN',
      'EPIPE',
      'EHOSTUNREACH',
      'ENETUNREACH',
      'ECONNABORTED',
    ].includes(code)
  ) {
    return true;
  }
  const m = String(err?.message || '').toLowerCase();
  return (
    m.includes('timeout') ||
    m.includes('socket hang up') ||
    m.includes('network') ||
    m.includes('getaddrinfo') ||
    m.includes('econn') ||
    m.includes('esocket') ||
    m.includes('failed to connect') ||
    m.includes('read econnreset') ||
    m.includes('wsdl') || // no pudo descargar el WSDL => el WS no responde
    m.includes('503') ||
    m.includes('502') ||
    m.includes('504')
  );
}

/**
 * Comprueba si los servicios web del SRI responden, antes de intentar enviar.
 * Hace un GET rápido al WSDL de Recepción: cualquier respuesta HTTP < 500 se
 * considera "disponible". Timeout / conexión rechazada / 5xx => no disponible.
 * @returns {Promise<boolean>}
 */
function checkSriAvailability(ambiente, timeoutMs = 8000) {
  const url = URLS[ambienteToKey(ambiente)].recepcion;
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const req = https.get(url, { timeout: timeoutMs }, (res) => {
        res.resume(); // drenar para liberar el socket
        done(Number(res.statusCode) > 0 && Number(res.statusCode) < 500);
      });
      req.on('timeout', () => {
        req.destroy();
        done(false);
      });
      req.on('error', () => done(false));
    } catch (_) {
      done(false);
    }
  });
}

module.exports = {
  enviarComprobante,
  autorizarComprobante,
  checkSriAvailability,
  isConnectivityError,
  URLS,
};
