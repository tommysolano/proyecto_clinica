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

module.exports = { startOfDay, endOfDay };
