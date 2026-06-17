/**
 * Utilidades puras para el auto-agendamiento público. Sin dependencias de BD,
 * para poder testearlas de forma aislada.
 */

const EC_OFFSET_MS = 5 * 60 * 60 * 1000; // Ecuador UTC-5

function toMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function toHHMM(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Genera todas las horas de inicio de slot entre hourFrom y hourTo (sin incluir
 * un slot que se pase de hourTo). Ej: 09:00..18:00 step 30 → 09:00,09:30,...,17:30.
 */
function generateSlots({ hourFrom, hourTo, slotMinutes }) {
  const start = toMinutes(hourFrom);
  const end = toMinutes(hourTo);
  const step = Number(slotMinutes) || 30;
  if (start == null || end == null || step <= 0 || start >= end) return [];
  const slots = [];
  for (let t = start; t + step <= end; t += step) slots.push(toHHMM(t));
  return slots;
}

/**
 * ¿El slot (hora de inicio + duración) cae dentro de algún rango bloqueado?
 * blockedRanges: [{ from:'HH:MM', to:'HH:MM' }] (allDay se representa con 00:00-23:59).
 */
function isBlocked(slot, durationMin, blockedRanges = []) {
  const s = toMinutes(slot);
  const e = s + (Number(durationMin) || 30);
  return blockedRanges.some((r) => {
    const bf = toMinutes(r.from);
    const bt = toMinutes(r.to);
    if (bf == null || bt == null) return false;
    return s < bt && e > bf; // solapamiento
  });
}

/**
 * Filtra los slots disponibles. PURO.
 * @param slots lista de 'HH:MM'
 * @param opts.takenCounts  mapa { 'HH:MM': nºcitas } ya agendadas a esa hora
 * @param opts.maxPerSlot   capacidad por slot
 * @param opts.durationMin  duración del servicio
 * @param opts.blockedRanges rangos bloqueados (TimeBlock)
 * @param opts.isToday      si la fecha es hoy
 * @param opts.nowHHMM      hora actual 'HH:MM' (para descartar slots pasados)
 */
function filterAvailable(slots, opts = {}) {
  const { takenCounts = {}, maxPerSlot = 1, durationMin = 30, blockedRanges = [], isToday = false, nowHHMM = '00:00' } = opts;
  const nowMin = toMinutes(nowHHMM) ?? 0;
  return slots.filter((slot) => {
    if (isToday && toMinutes(slot) <= nowMin) return false;
    if ((takenCounts[slot] || 0) >= maxPerSlot) return false;
    if (isBlocked(slot, durationMin, blockedRanges)) return false;
    return true;
  });
}

/** Hora actual 'HH:MM' en Ecuador. */
function ecNowHHMM(now = new Date()) {
  const ec = new Date(now.getTime() - EC_OFFSET_MS);
  return `${String(ec.getUTCHours()).padStart(2, '0')}:${String(ec.getUTCMinutes()).padStart(2, '0')}`;
}

/** Día calendario de Ecuador (medianoche UTC) para una fecha YYYY-MM-DD. */
function parseLocalDate(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0, 0);
}

function addMinutesHHMM(hhmm, mins) {
  const t = toMinutes(hhmm);
  if (t == null) return '';
  return toHHMM(t + (Number(mins) || 0));
}

module.exports = {
  toMinutes,
  toHHMM,
  generateSlots,
  isBlocked,
  filterAvailable,
  ecNowHHMM,
  parseLocalDate,
  addMinutesHHMM,
};
