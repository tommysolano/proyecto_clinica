/**
 * Generación XML de Anulación de comprobante (formato del SRI).
 *
 * El SRI ofrece dos vías para anular:
 *   1. Portal web del SRI (interactivo) — requiere usuario y contraseña
 *      del contribuyente. Esta opción NO se puede automatizar desde un
 *      software propio porque es un formulario.
 *   2. Web Service de anulación (cuando esté disponible).
 *
 * Este módulo deja preparada la estructura local del comprobante anulado
 * y registra el motivo. La anulación efectiva ante el SRI debe realizarse
 * a través del portal del contribuyente.
 */
const { create } = require('xmlbuilder2');

function buildAnulacionXml({ claveAcceso, ruc, razonSocial, motivo, secuencial, fecha }) {
  const root = create({ version: '1.0', encoding: 'UTF-8' }).ele('anulacionComprobante', {
    id: 'anulacion',
    version: '1.0.0',
  });
  root.ele('ruc').txt(ruc);
  root.ele('razonSocial').txt(razonSocial);
  root.ele('claveAcceso').txt(claveAcceso);
  root.ele('secuencial').txt(secuencial);
  root.ele('fecha').txt(fecha);
  root.ele('motivo').txt(motivo);
  return root.end({ prettyPrint: false });
}

module.exports = { buildAnulacionXml };
