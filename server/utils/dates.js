/**
 * Helpers de rango de fechas para reportes contables.
 *
 * Un `endDate` tipo 'YYYY-MM-DD' parseado con `new Date(endDate)` queda en medianoche UTC,
 * lo que EXCLUYE los asientos del mismo día (zona EC −5). `endOfDay` lo lleva al final del
 * día para que el rango sea inclusivo. `startOfDay`/`endOfDay` aceptan string o Date.
 */
function startOfDay(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  return new Date(`${value}T00:00:00.000`);
}

function endOfDay(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  return new Date(`${value}T23:59:59.999`);
}

/**
 * Normaliza la fecha de un COMPROBANTE (fecha de emisión de compra/retención) al MEDIODÍA LOCAL
 * de la fecha calendario elegida.
 *
 * El bug que corrige: el date-picker envía "YYYY-MM-DD" y el cliente hace `new Date("YYYY-MM-DD")`,
 * que es MEDIANOCHE UTC. En Ecuador (UTC−5) eso es el día ANTERIOR a las 19:00; una compra del
 * día 1 quedaba en el mes anterior y desaparecía del rango local del 103/104 (casillero 332 = 0).
 * Anclando al mediodía local, la fecha cae siempre dentro del mismo día calendario en cualquier
 * zona razonable y el comprobante se declara en su mes real.
 *
 * Acepta 'YYYY-MM-DD' (día del picker), Date o ISO. Para valores CON hora usa las PARTES UTC
 * (la fecha que el usuario escogió) y las reancla a mediodía local. Idempotente.
 */
function invoiceDate(value) {
  if (!value) return value;
  if (typeof value === 'string') {
    const m = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  }
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return d;
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12, 0, 0, 0);
}

module.exports = { startOfDay, endOfDay, invoiceDate };
