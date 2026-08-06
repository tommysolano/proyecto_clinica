/**
 * VENTANAS HORARIAS de las automatizaciones (estilo GoHighLevel "Time Window" /
 * Daplox "ventanas"): franjas de días + horas en las que el flujo puede ENVIAR.
 *
 * Un contacto que llega fuera de la ventana NO se descarta ni se envía tarde: la
 * inscripción queda `waiting` hasta la PRÓXIMA apertura de la ventana (así un
 * lead que escribe a las 23:00 recibe su mensaje a las 08:00 del día siguiente).
 *
 * Dos niveles, como en GoHighLevel:
 *  - Ventana del WORKFLOW (`workflow.sendWindow`): aplica a todos los pasos de
 *    ENVÍO del flujo (mensaje/plantilla/media/email/reseña/IA).
 *  - Nodo "Ventana horaria" (`type: 'window'`): retiene el flujo en ese punto
 *    hasta que la franja esté abierta, sea cual sea el paso siguiente.
 *
 * Todo se calcula en HORA LOCAL del proceso, que index.js fija en
 * America/Guayaquil (ver zona-horaria del proyecto). Funciones PURAS y testeables.
 */

const MINUTES_PER_DAY = 1440;
const DAY_MS = 24 * 60 * 60 * 1000;
// Cuántos días adelante se busca una apertura antes de rendirse. 8 basta para
// cualquier configuración (peor caso: un único día de la semana habilitado).
const MAX_LOOKAHEAD_DAYS = 8;

const DAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** "HH:MM" → minutos desde medianoche, o null si no es válido. */
function parseHHMM(value) {
  const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** minutos desde medianoche → "HH:MM" (para textos del registro). */
function formatHHMM(minutes) {
  const m = ((Number(minutes) || 0) % MINUTES_PER_DAY + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Días válidos (0=domingo … 6=sábado), sin repetidos y ordenados. */
function normalizeDays(days) {
  const list = (Array.isArray(days) ? days : [])
    .map((d) => Number(d))
    .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return [...new Set(list)].sort((a, b) => a - b);
}

/**
 * ¿La ventana está ACTIVA (restringe algo)? Una ventana en modo 'any', sin días
 * o con horas inválidas no restringe nada: el flujo trabaja 24/7 como siempre.
 */
function isWindowActive(win) {
  if (!win || win.mode !== 'specific') return false;
  if (!normalizeDays(win.days).length) return false;
  return parseHHMM(win.from) !== null && parseHHMM(win.to) !== null;
}

/**
 * Duración de la franja en minutos. `from === to` = día completo (1440); si
 * `from > to` la franja CRUZA la medianoche (p.ej. 20:00→06:00) y el día
 * seleccionado es el del INICIO.
 */
function windowDurationMinutes(fromMin, toMin) {
  const diff = (toMin - fromMin + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  return diff === 0 ? MINUTES_PER_DAY : diff;
}

/** Fecha del inicio del día local de `date` (00:00). */
function startOfLocalDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Apertura de la franja del día `dayStart` (Date a las 00:00) o null si ese día
 * de la semana no está habilitado. Devuelve { start, end } (end exclusivo).
 */
function slotForDay(win, dayStart, fromMin, duration) {
  const days = normalizeDays(win.days);
  if (!days.includes(dayStart.getDay())) return null;
  const start = new Date(dayStart.getTime());
  start.setMinutes(fromMin);
  return { start, end: new Date(start.getTime() + duration * 60000) };
}

/**
 * ¿`date` cae DENTRO de la ventana? Una ventana inactiva devuelve true (no
 * restringe). Contempla las franjas que cruzan la medianoche mirando también la
 * franja que arrancó el día anterior.
 */
function isInsideWindow(win, date = new Date()) {
  if (!isWindowActive(win)) return true;
  const fromMin = parseHHMM(win.from);
  const duration = windowDurationMinutes(fromMin, parseHHMM(win.to));
  const t = date.getTime();
  const today = startOfLocalDay(date);
  for (let i = -1; i <= 0; i += 1) {
    const slot = slotForDay(win, new Date(today.getTime() + i * DAY_MS), fromMin, duration);
    if (slot && t >= slot.start.getTime() && t < slot.end.getTime()) return true;
  }
  return false;
}

/**
 * Momento en el que el flujo puede continuar:
 *  - `from` si YA está dentro de la ventana (o la ventana no restringe),
 *  - la PRÓXIMA apertura si está fuera,
 *  - null si la ventana es imposible de abrir (no debería pasar: isWindowActive
 *    ya exige al menos un día).
 * PURA: no toca el reloj salvo por el `from` que se le pasa.
 */
function nextWindowOpening(win, from = new Date()) {
  if (!isWindowActive(win)) return from;
  if (isInsideWindow(win, from)) return from;
  const fromMin = parseHHMM(win.from);
  const duration = windowDurationMinutes(fromMin, parseHHMM(win.to));
  const today = startOfLocalDay(from);
  for (let i = 0; i <= MAX_LOOKAHEAD_DAYS; i += 1) {
    const slot = slotForDay(win, new Date(today.getTime() + i * DAY_MS), fromMin, duration);
    if (slot && slot.start.getTime() > from.getTime()) return slot.start;
  }
  return null;
}

/** Texto de la ventana para el registro de ejecución ("lun a vie, 08:00–18:00"). */
function describeWindow(win) {
  if (!isWindowActive(win)) return 'sin restricción';
  const days = normalizeDays(win.days);
  const label = days.length === 7 ? 'todos los días' : days.map((d) => DAY_NAMES[d]).join(', ');
  return `${label} de ${formatHHMM(parseHHMM(win.from))} a ${formatHHMM(parseHHMM(win.to))}`;
}

module.exports = {
  DAY_NAMES,
  parseHHMM,
  formatHHMM,
  normalizeDays,
  isWindowActive,
  isInsideWindow,
  nextWindowOpening,
  describeWindow,
};
