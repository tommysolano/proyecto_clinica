/**
 * Fechas de citas en zona horaria del sistema (America/Guayaquil, forzada en
 * index.js con process.env.TZ). Regla de negocio: no se puede agendar una cita
 * en una fecha (día calendario) anterior a HOY. Se centraliza aquí para que
 * TODAS las vías de agendamiento (página de Citas, chat/CRM, reserva pública)
 * apliquen exactamente la misma validación.
 */

// Medianoche de hoy en hora local.
function startOfToday() {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  return now;
}

// Normaliza 'YYYY-MM-DD' (o Date/ISO) a Date local a las 12:00 (evita que el
// cambio de zona horaria mueva el día al guardar/leer).
function parseLocalDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

// ¿La fecha (día calendario, hora local) es anterior a hoy? Una fecha inválida
// devuelve false: la validez del formato la comprueba el caller por separado.
function isPastLocalDate(value) {
  const d = parseLocalDate(value);
  if (!d || Number.isNaN(d.getTime())) return false;
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  return day.getTime() < startOfToday().getTime();
}

// ¿Dos fechas caen en el mismo día calendario (hora local)?
function isSameLocalDay(a, b) {
  const da = parseLocalDate(a);
  const db = parseLocalDate(b);
  if (!da || !db) return false;
  return (
    da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate()
  );
}

const PAST_DATE_MESSAGE = 'No se puede agendar una cita en una fecha anterior a hoy.';

module.exports = { startOfToday, parseLocalDate, isPastLocalDate, isSameLocalDay, PAST_DATE_MESSAGE };
