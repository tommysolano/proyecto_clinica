/**
 * Cliente SOAP para los servicios web del SRI:
 *   - Recepción Comprobantes Offline
 *   - Autorización Comprobantes Offline
 */
const soap = require('soap');

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

module.exports = { enviarComprobante, autorizarComprobante, URLS };
