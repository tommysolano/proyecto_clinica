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
const PAST_TIME_MESSAGE = 'No se puede agendar una cita en un horario que ya pasó.';

/**
 * ¿La fecha + hora de inicio ('HH:MM', hora local Ecuador) ya pasó?
 * - Día anterior a hoy → true (aunque no haya hora).
 * - Hoy con hora anterior a la actual → true.
 * - Día futuro u hora inválida → false (el formato lo valida el caller).
 * `now` es inyectable para tests.
 */
function isPastLocalDateTime(dateValue, startTime, now = new Date()) {
  const d = parseLocalDate(dateValue);
  if (!d || Number.isNaN(d.getTime())) return false;
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (day.getTime() < today.getTime()) return true;
  if (day.getTime() > today.getTime()) return false;
  const m = String(startTime || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return minutes < now.getHours() * 60 + now.getMinutes();
}

// Combina el día calendario de la cita (campo `date`) con su hora de inicio
// (`startTime`, 'HH:MM') en un Date con la hora REAL de la cita en Ecuador
// (UTC-5 fijo, sin horario de verano). El día se toma en UTC porque las dos
// formas históricas de guardado (medianoche UTC y 12:00 local) caen en el día
// correcto leídas en UTC. Sin startTime válido devuelve la fecha tal cual.
function appointmentDateTime(date, startTime) {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  const m = String(startTime || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return d;
  const day = d.toISOString().slice(0, 10);
  return new Date(`${day}T${m[1].padStart(2, '0')}:${m[2]}:00-05:00`);
}

module.exports = {
  startOfToday,
  parseLocalDate,
  isPastLocalDate,
  isPastLocalDateTime,
  isSameLocalDay,
  appointmentDateTime,
  PAST_DATE_MESSAGE,
  PAST_TIME_MESSAGE,
};
