/**
 * Rango de fechas para reportes SRI/contables por período flexible.
 *
 * Resuelve, desde los query params, un rango [start, end] con etiqueta legible,
 * soportando:
 *   - MONTHLY        (año + mes)              → compat legacy con year/month
 *   - FIRST_SEMESTER (01/01 – 30/06)
 *   - SECOND_SEMESTER(01/07 – 31/12)
 *   - ANNUAL         (01/01 – 31/12)
 *   - CUSTOM         (startDate – endDate)
 *
 * Compatibilidad legacy: si NO llega `periodType`, se infiere:
 *   startDate/endDate → CUSTOM · month presente → MONTHLY · solo año → ANNUAL.
 *
 * Fechas en hora LOCAL del servidor (misma convención que utils/dates y que los
 * rangos `new Date(y, m-1, 1)` usados hasta ahora). `start` = inicio del día,
 * `end` = fin del día (inclusivo).
 */
const { startOfDay, endOfDay } = require('./dates');

const PERIOD_TYPES = ['MONTHLY', 'FIRST_SEMESTER', 'SECOND_SEMESTER', 'ANNUAL', 'CUSTOM'];
const MONTH_NAMES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const pad2 = (n) => String(n).padStart(2, '0');

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function firstOfMonth(y, m) { return new Date(y, m - 1, 1, 0, 0, 0, 0); }
function lastOfMonth(y, m) { return new Date(y, m, 0, 23, 59, 59, 999); }
function fmtDMY(d) { return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}/${d.getFullYear()}`; }

/**
 * @param {object} query - { year, month, periodType, startDate, endDate }
 * @returns {{ start: Date, end: Date, label: string, year: number, month: number|null, periodType: string }}
 * @throws {Error} con `.status = 400` si los parámetros son inválidos.
 */
function resolveReportRange(query = {}) {
  const q = query || {};
  const now = new Date();

  const hasYear = q.year !== undefined && q.year !== null && q.year !== '';
  const year = hasYear ? parseInt(q.year, 10) : now.getFullYear();
  const hasMonth = q.month !== undefined && q.month !== null && q.month !== '';
  const monthRaw = hasMonth ? parseInt(q.month, 10) : null;

  // Tipo de período (compat legacy si no viene explícito).
  let periodType = q.periodType ? String(q.periodType).toUpperCase() : null;
  if (!periodType) {
    if (q.startDate || q.endDate) periodType = 'CUSTOM';
    else if (hasMonth) periodType = 'MONTHLY';
    else periodType = 'ANNUAL';
  }
  if (!PERIOD_TYPES.includes(periodType)) {
    throw badRequest(`Tipo de período inválido: ${periodType}. Use uno de: ${PERIOD_TYPES.join(', ')}.`);
  }

  // Año válido para todos los tipos basados en año (CUSTOM usa fechas explícitas).
  if (periodType !== 'CUSTOM' && (!Number.isInteger(year) || year < 1900 || year > 3000)) {
    throw badRequest('Año inválido.');
  }

  let start;
  let end;
  let label;
  let month = null;

  switch (periodType) {
    case 'MONTHLY': {
      const m = hasMonth ? monthRaw : (now.getMonth() + 1);
      if (!Number.isInteger(m) || m < 1 || m > 12) throw badRequest('Mes inválido (debe ser 1-12).');
      start = firstOfMonth(year, m);
      end = lastOfMonth(year, m);
      label = `${MONTH_NAMES[m - 1]} ${year}`;
      month = m;
      break;
    }
    case 'FIRST_SEMESTER':
      start = firstOfMonth(year, 1);
      end = lastOfMonth(year, 6);
      label = `Primer semestre ${year}`;
      break;
    case 'SECOND_SEMESTER':
      start = firstOfMonth(year, 7);
      end = lastOfMonth(year, 12);
      label = `Segundo semestre ${year}`;
      break;
    case 'ANNUAL':
      start = firstOfMonth(year, 1);
      end = lastOfMonth(year, 12);
      label = `Año ${year}`;
      break;
    case 'CUSTOM': {
      if (!q.startDate || !q.endDate) {
        throw badRequest('El rango personalizado requiere fecha de inicio y fecha de fin.');
      }
      start = startOfDay(q.startDate);
      end = endOfDay(q.endDate);
      if (!start || Number.isNaN(start.getTime())) throw badRequest('Fecha de inicio inválida.');
      if (!end || Number.isNaN(end.getTime())) throw badRequest('Fecha de fin inválida.');
      label = `${fmtDMY(start)} - ${fmtDMY(end)}`;
      break;
    }
    default:
      throw badRequest(`Tipo de período no soportado: ${periodType}.`);
  }

  if (start.getTime() > end.getTime()) {
    throw badRequest('La fecha de inicio no puede ser posterior a la fecha de fin.');
  }

  return { start, end, label, year: periodType === 'CUSTOM' ? null : year, month, periodType };
}

/** ¿El rango corresponde a un único mes calendario (para exportaciones oficiales mensuales)? */
function isMonthlyRange(range) {
  return !!range && range.periodType === 'MONTHLY' && Number.isInteger(range.month);
}

/**
 * Parsea 'DD/MM/YYYY' → Date (mediodía local, para evitar cruces de día por zona
 * horaria). Devuelve null si el string no es una fecha válida.
 */
function parseDMY(str) {
  if (!str || typeof str !== 'string') return null;
  const m = str.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (!m) return null;
  const d = parseInt(m[1], 10);
  const mo = parseInt(m[2], 10);
  const y = parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d, 12, 0, 0, 0);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/**
 * Fecha FISCAL de una factura de venta (Invoice.fechaEmision es String 'DD/MM/YYYY').
 * Usa la fecha de emisión si es válida; si no, cae a createdAt.
 */
function invoiceFiscalDate(inv) {
  if (!inv) return null;
  return parseDMY(inv.fechaEmision) || (inv.createdAt ? new Date(inv.createdAt) : null);
}

/**
 * Fecha FISCAL de una compra (PurchaseInvoice.fechaEmision es Date). Usa la fecha
 * de emisión si es válida; si no, cae a createdAt.
 */
function purchaseFiscalDate(pi) {
  if (!pi) return null;
  if (pi.fechaEmision instanceof Date && !Number.isNaN(pi.fechaEmision.getTime())) return pi.fechaEmision;
  if (pi.fechaEmision) {
    const d = new Date(pi.fechaEmision);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return pi.createdAt ? new Date(pi.createdAt) : null;
}

/** ¿`date` cae dentro de [start, end] (inclusivo)? */
function inRange(date, start, end) {
  if (!date || Number.isNaN(date.getTime())) return false;
  const t = date.getTime();
  return t >= start.getTime() && t <= end.getTime();
}

module.exports = {
  PERIOD_TYPES,
  resolveReportRange,
  isMonthlyRange,
  parseDMY,
  invoiceFiscalDate,
  purchaseFiscalDate,
  inRange,
};
