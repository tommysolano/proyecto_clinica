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
  intervals: [{ start: '09:00', end: '18:00' }],
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
      // Compatibilidad: los horarios guardados antes de admitir varias franjas
      // solo tienen start/end. Al leerlos se convierten en la primera franja.
      const suppliedIntervals = Array.isArray(item.intervals) ? item.intervals : [];
      const intervalSource = suppliedIntervals.length
        ? suppliedIntervals
        : [{ start: item.start, end: item.end }];
      const intervals = intervalSource.slice(0, 12).map((interval) => ({
        start: cleanTime(interval?.start, fallback.start),
        end: cleanTime(interval?.end, fallback.end),
      }));
      const first = intervals[0] || fallback.intervals[0];
      return {
        day: fallback.day,
        enabled: item.enabled === undefined ? fallback.enabled : item.enabled === true,
        // Estos dos campos permiten que clientes antiguos sigan mostrando la
        // primera franja mientras migran al arreglo intervals.
        start: first.start,
        end: first.end,
        intervals,
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
  const overlaps = [];

  // Tope defensivo de 20 años para datos corruptos; un tiempo de primera
  // respuesta normal recorre horas o días.
  for (let guard = 0; cursor <= lastDay && guard < 7310; guard++, cursor += 86400000) {
    const dayDate = new Date(cursor);
    const slot = schedule.days.find((d) => d.day === dayDate.getUTCDay());
    if (!slot?.enabled) continue;
    for (const interval of slot.intervals) {
      let slotStart = ecLocalToUtcMs(
        dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate(), interval.start
      );
      let slotEnd = ecLocalToUtcMs(
        dayDate.getUTCFullYear(), dayDate.getUTCMonth(), dayDate.getUTCDate(), interval.end
      );
      if (slotEnd <= slotStart) slotEnd += 86400000; // turno nocturno
      const overlapStart = Math.max(startMs, slotStart);
      const overlapEnd = Math.min(endMs, slotEnd);
      if (overlapEnd > overlapStart) overlaps.push([overlapStart, overlapEnd]);
    }
  }

  // Unimos solapamientos para que una configuracion duplicada o un turno
  // nocturno que alcance la franja del dia siguiente no cuente minutos dos veces.
  overlaps.sort((a, b) => a[0] - b[0]);
  let total = 0;
  let mergedStart = null;
  let mergedEnd = null;
  for (const [rangeStart, rangeEnd] of overlaps) {
    if (mergedStart === null) {
      mergedStart = rangeStart;
      mergedEnd = rangeEnd;
    } else if (rangeStart <= mergedEnd) {
      mergedEnd = Math.max(mergedEnd, rangeEnd);
    } else {
      total += mergedEnd - mergedStart;
      mergedStart = rangeStart;
      mergedEnd = rangeEnd;
    }
  }
  if (mergedStart !== null) total += mergedEnd - mergedStart;
  return total;
}

/** Día de la semana (0=domingo) de una fecha 'YYYY-MM-DD' escrita en Ecuador. */
function ecWeekday(dayKey) {
  const [y, m, d] = String(dayKey).split('-').map(Number);
  if (!y || !m || !d) return -1;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** Clave 'YYYY-MM-DD' del día ECUATORIANO de un instante. */
function ecDayKey(instant) {
  return new Date(new Date(instant).getTime() - EC_OFFSET_MS).toISOString().slice(0, 10);
}

/** Minutos transcurridos desde la medianoche ecuatoriana de un instante. */
function ecMinutesOfDay(instant) {
  const local = new Date(new Date(instant).getTime() - EC_OFFSET_MS);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Minutos desde medianoche de un 'HH:mm'. */
function clockMinutes(value) {
  const [hour, minute] = timeParts(value);
  return hour * 60 + minute;
}

/**
 * Turno del asesor en un día concreto: de la PRIMERA franja a la ÚLTIMA (el hueco
 * del almuerzo queda dentro, que es lo que se mira para "entró/salió a su hora").
 * Devuelve `null` si no tiene horario activo o ese día no trabaja.
 */
function shiftForDay(rawSchedule, dayKey) {
  const schedule = normalizeSchedule(rawSchedule);
  if (!schedule.enabled) return null;
  const slot = schedule.days.find((d) => d.day === ecWeekday(dayKey));
  if (!slot?.enabled || !slot.intervals.length) return null;
  const start = slot.intervals[0].start;
  const end = slot.intervals[slot.intervals.length - 1].end;
  const startMinutes = clockMinutes(start);
  // Turno nocturno (22:00–06:00): el fin cae en el día siguiente.
  const rawEnd = clockMinutes(end);
  return {
    start,
    end,
    startMinutes,
    endMinutes: rawEnd <= startMinutes ? rawEnd + 1440 : rawEnd,
    overnight: rawEnd <= startMinutes,
    intervals: slot.intervals,
  };
}

function isWorkingAt(rawSchedule, at = new Date()) {
  const schedule = normalizeSchedule(rawSchedule);
  if (!schedule.enabled) return true;
  const instant = new Date(at).getTime();
  // Un minuto alrededor del instante basta y reutiliza exactamente las mismas
  // reglas (incluidos turnos nocturnos).
  return workingMsBetween(new Date(instant), new Date(instant + 60000), schedule) > 0;
}

module.exports = {
  DEFAULT_DAYS,
  TIME_RE,
  normalizeSchedule,
  workingMsBetween,
  isWorkingAt,
  ecWeekday,
  ecDayKey,
  ecMinutesOfDay,
  clockMinutes,
  shiftForDay,
};
