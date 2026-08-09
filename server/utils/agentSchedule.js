/**
 * Horario laboral de los asesores del call center.
 *
 * Ecuador usa UTC-5 todo el año. Se calcula con ese offset fijo para que los
 * resultados sean iguales en producción, en una laptop y en los tests, sin
 * depender de la zona horaria del proceso de Node.
 */
const EC_OFFSET_MS = 5 * 60 * 60 * 1000;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const DEFAULT_DAYS = Array.from({ length: 7 }, (_, day) => ({
  day,
  enabled: day >= 1 && day <= 5,
  start: '09:00',
  end: '18:00',
}));

function cleanTime(value, fallback) {
  const text = String(value || '').trim();
  return TIME_RE.test(text) ? text : fallback;
}

function normalizeSchedule(raw = {}) {
  const source = raw?.toObject ? raw.toObject() : raw || {};
  const given = Array.isArray(source.days) ? source.days : [];
  const byDay = new Map(given.map((item) => [Number(item?.day), item]));
  return {
    enabled: source.enabled === true,
    timezone: 'America/Guayaquil',
    days: DEFAULT_DAYS.map((fallback) => {
      const item = byDay.get(fallback.day) || {};
      return {
        day: fallback.day,
        enabled: item.enabled === undefined ? fallback.enabled : item.enabled === true,
        start: cleanTime(item.start, fallback.start),
        end: cleanTime(item.end, fallback.end),
      };
    }),
  };
}

const timeParts = (value) => {
  const match = TIME_RE.exec(String(value || ''));
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
};

// Fecha/hora escrita en Ecuador -> instante UTC real.
function ecLocalToUtcMs(year, month, date, time) {
  const [hour, minute] = timeParts(time);
  return Date.UTC(year, month, date, hour, minute) + EC_OFFSET_MS;
}

/**
 * Milisegundos laborables entre dos instantes. Si el asesor no activó horario,
 * conserva el comportamiento histórico (24/7). Admite turnos que crucen
 * medianoche, p.ej. 22:00–06:00.
 */
function workingMsBetween(from, to, rawSchedule) {
  const startMs = new Date(from).getTime();
  const endMs = new Date(to).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0;

  const schedule = normalizeSchedule(rawSchedule);
  if (!schedule.enabled) return endMs - startMs;

  // Convertimos el inicio/fin a un reloj local ecuatoriano representado en UTC,
  // para iterar fechas con getUTC* sin depender del TZ del servidor.
  const localStart = new Date(startMs - EC_OFFSET_MS);
  const localEnd = new Date(endMs - EC_OFFSET_MS);
  // Empieza un día antes: un turno del lunes 22:00–06:00 sigue activo durante
  // la madrugada del martes.
  let cursor = Date.UTC(localStart.getUTCFullYear(), localStart.getUTCMonth(), localStart.getUTCDate()) - 86400000;
  const lastDay = Date.UTC(localEnd.getUTCFullYear(), localEnd.getUTCMonth(), localEnd.getUTCDate());
  let total = 0;

  // Tope defensivo de 20 años para datos corruptos; un tiempo de primera
  // respuesta normal recorre horas o días.
  for (let guard = 0; cursor <= lastDay && guard < 7310; guard++, cursor += 86400000) {
    const dayDate = new Date(cursor);
    const slot = schedule.days.find((d) => d.day === dayDate.getUTCDay());
    if (!slot?.enabled) continue;
    let slotStart = ecLocalToUtcMs(
      dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate(), slot.start
    );
    let slotEnd = ecLocalToUtcMs(
      dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate(), slot.end
    );
    if (slotEnd <= slotStart) slotEnd += 86400000; // turno nocturno
    const overlapStart = Math.max(startMs, slotStart);
    const overlapEnd = Math.min(endMs, slotEnd);
    if (overlapEnd > overlapStart) total += overlapEnd - overlapStart;
  }
  return total;
}

function isWorkingAt(rawSchedule, at = new Date()) {
  const schedule = normalizeSchedule(rawSchedule);
  if (!schedule.enabled) return true;
  const instant = new Date(at).getTime();
  // Un minuto alrededor del instante basta y reutiliza exactamente las mismas
  // reglas (incluidos turnos nocturnos).
  return workingMsBetween(new Date(instant), new Date(instant + 60000), schedule) > 0;
}

module.exports = { DEFAULT_DAYS, TIME_RE, normalizeSchedule, workingMsBetween, isWorkingAt };
