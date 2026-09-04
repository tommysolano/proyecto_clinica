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

/**
 * ¿La fecha (día calendario, hora local) es POSTERIOR a hoy?
 *
 * Lo usa la asignación de atención: dejar preparado el doctor de una cita de
 * mañana no puede darla por asistida hoy. Una fecha inválida devuelve false,
 * igual que `isPastLocalDate`: el formato lo comprueba el caller.
 */
function isFutureLocalDate(value) {
  const d = parseLocalDate(value);
  if (!d || Number.isNaN(d.getTime())) return false;
  const day = new Date(d);
  day.setHours(0, 0, 0, 0);
  return day.getTime() > startOfToday().getTime();
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

/**
 * ESPACIOS DE LA AGENDA.
 *
 * Con `slotMinutes = 20` una cita solo puede empezar a las 14:00, 14:20, 14:40…
 * Se mide desde la medianoche, que es lo que hace que la rejilla sea la misma
 * todos los días y que 60 caiga siempre en hora en punto.
 *
 * `0` (o nada) = sin rejilla, cualquier hora: es el comportamiento de siempre y
 * el valor por defecto de las sucursales que no lo han configurado.
 */
function isValidSlotTime(startTime, slotMinutes) {
  const paso = Number(slotMinutes) || 0;
  if (paso <= 0) return true;
  const m = String(startTime || '').match(/^(\d{1,2}):(\d{2})$/);
  // Formato inválido: lo valida el caller, aquí no se inventa un rechazo.
  if (!m) return true;
  return (Number(m[1]) * 60 + Number(m[2])) % paso === 0;
}

/** Las horas válidas de un día con esa rejilla: ['00:00','00:20',…]. */
function slotTimesOfDay(slotMinutes) {
  const paso = Number(slotMinutes) || 0;
  if (paso <= 0) return [];
  const out = [];
  for (let t = 0; t < 24 * 60; t += paso) {
    out.push(`${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`);
  }
  return out;
}

/** El mensaje dice a qué horas SÍ se puede, que es lo que hace falta saber. */
function slotMessage(slotMinutes) {
  const paso = Number(slotMinutes) || 0;
  const ejemplos = slotTimesOfDay(paso).filter((t) => t >= '14:00').slice(0, 3).join(', ');
  return `Esta sucursal agenda en espacios de ${paso} minutos: la hora tiene que caer en la rejilla (por ejemplo ${ejemplos}…).`;
}

/**
 * Hora actual 'HH:mm' en hora de Ecuador.
 *
 * Vive aquí y no en un controlador porque la usan varios: sellar la toma de
 * signos vitales y poner la hora de una atención inmediata. Y es la hora REAL a
 * la que entró el paciente, no una redonda: en una atención sin cita no hay
 * rejilla de horarios que respetar, y forzar una hora bonita mentiría sobre
 * cuándo se atendió.
 */
function nowHHMM() {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Guayaquil',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
    .format(new Date())
    .replace(/^24:/, '00:');
}

/**
 * EL DÍA de un instante, a las 12:00 locales.
 *
 * `Appointment.date` es un DÍA, no un momento: la hora vive en `startTime`. Toda
 * cita agendada se guarda así (`parseLocalDate` fija las 12:00 para que ningún
 * cambio de zona horaria mueva el día), y la agenda filtra el día contra ese
 * formato.
 *
 * Existe porque una cita registrada con `new Date()` a secas —las atenciones sin
 * cita— guardaba la HORA dentro del campo del día, y una atención de la mañana
 * quedaba por debajo del corte del filtro: la cita existía, pero no salía en la
 * lista del día. Cualquier cita que se cree con la hora que sea tiene que pasar
 * por aquí.
 */
function localDayAtNoon(value = new Date()) {
  const d = value instanceof Date ? value : new Date(value);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0, 0, 0);
}

module.exports = {
  nowHHMM,
  startOfToday,
  parseLocalDate,
  localDayAtNoon,
  isPastLocalDate,
  isFutureLocalDate,
  isPastLocalDateTime,
  isSameLocalDay,
  appointmentDateTime,
  isValidSlotTime,
  slotTimesOfDay,
  slotMessage,
  PAST_DATE_MESSAGE,
  PAST_TIME_MESSAGE,
};
