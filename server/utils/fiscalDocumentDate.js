/**
 * FECHA DE LOS DOCUMENTOS FISCALES (compras, ventas/facturas y retenciones).
 *
 * Regla de negocio pedida por la administración: la fecha de un comprobante es AUTOMÁTICA
 * (hoy) y el sistema NO admite registrar un documento con fecha ANTERIOR a hoy —tampoco
 * importándolo—. Se centraliza aquí para que todas las vías (formulario, importador TXT/XML
 * del SRI, emisión de retención) apliquen exactamente la misma comprobación, igual que
 * `appointmentDate.js` hace con las citas.
 *
 * Zona horaria: todo el sistema corre en America/Guayaquil (index.js fuerza process.env.TZ),
 * así que "hoy" es el día calendario ecuatoriano.
 *
 * MATIZ IMPORTANTE (no es una excepción a la regla, es lo que hace la regla aplicable):
 * al EDITAR un documento ya guardado solo se comprueba la fecha si CAMBIA. Un comprobante
 * histórico que ya existe conserva su fecha; lo que se prohíbe es *fijar* una fecha pasada.
 * Sin esto, corregir el proveedor de una compra del mes pasado sería imposible.
 */

const { parseLocalDate, startOfToday } = require('./appointmentDate');

const PAST_DOCUMENT_DATE_MESSAGE =
  'No se puede registrar un comprobante con fecha anterior a hoy. La fecha de emisión es automática.';

/** Día calendario (hora local) de un valor, o null si no es una fecha válida. */
function localDay(value) {
  const d = parseLocalDate(value);
  if (!d || Number.isNaN(d.getTime())) return null;
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  return day;
}

/** ¿La fecha cae en un día calendario anterior a hoy? Fecha inválida ⇒ false. */
function isPastDocumentDate(value) {
  const day = localDay(value);
  if (!day) return false;
  return day.getTime() < startOfToday().getTime();
}

/** ¿Dos valores caen en el mismo día calendario local? (para detectar "la fecha no cambió"). */
function isSameDocumentDay(a, b) {
  const da = localDay(a);
  const db = localDay(b);
  if (!da || !db) return false;
  return da.getTime() === db.getTime();
}

/**
 * Lanza 400 si `value` es una fecha anterior a hoy.
 *
 * @param {*} value fecha propuesta ('YYYY-MM-DD', ISO o Date)
 * @param {object} opts
 * @param {string} opts.label   nombre del documento para el mensaje ('la factura de compra'…)
 * @param {*}      opts.current fecha que YA tenía el documento: si el día no cambia, no se valida
 */
function assertNotPastDocumentDate(value, { label = 'el comprobante', current = null } = {}) {
  if (value == null || value === '') return;
  if (current != null && isSameDocumentDay(value, current)) return; // la fecha no cambió
  if (!isPastDocumentDate(value)) return;
  const d = localDay(value);
  const shown = d ? d.toLocaleDateString('es-EC', { timeZone: 'America/Guayaquil' }) : String(value);
  throw Object.assign(
    new Error(
      `No se puede registrar ${label} con fecha ${shown}: es anterior a hoy. `
      + 'La fecha de emisión es automática y no admite fechas atrasadas.'
    ),
    { status: 400, code: 'PAST_DOCUMENT_DATE' }
  );
}

module.exports = {
  PAST_DOCUMENT_DATE_MESSAGE,
  isPastDocumentDate,
  isSameDocumentDay,
  assertNotPastDocumentDate,
};
