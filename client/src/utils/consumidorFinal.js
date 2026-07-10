// Cédulas "genéricas" que el SRI trata como consumidor final (mismo criterio que
// el backend en invoiceController.tipoIdentificacion: vacío o 13 nueves → 07).
const GENERIC_IDS = new Set(['', '9999999999', '9999999999999']);

/**
 * ¿La factura se emitirá a CONSUMIDOR FINAL? True cuando la identificación está
 * vacía o es una de las genéricas (9999999999 / 9999999999999). El nombre no se
 * usa para decidir (puede haberse editado); manda la identificación fiscal.
 */
export function isConsumidorFinal(cedula) {
  return GENERIC_IDS.has(String(cedula || '').trim());
}
