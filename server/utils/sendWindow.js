/**
 * VENTANAS HORARIAS de las automatizaciones: franjas de días + horas en las que
 * el flujo NO debe molestar al contacto.
 *
 * OJO — EL SIGNIFICADO ES "SILENCIO", NO "PERMITIDO" (ago-2026). Antes el rango
 * era el horario en el que la automatización PODÍA enviar (estilo "Time Window"
 * de GoHighLevel). En la práctica nadie lo entendía así: las 15 ventanas
 * configuradas en producción decían `23:00–06:20`, o sea "no molestar de noche"…
 * y el sistema hacía justo lo contrario, reteniendo los mensajes todo el día para
 * soltarlos a las 23:00. Se enviaron 2.061 mensajes de madrugada en 5 días. Ahora
 * el rango es lo que la gente lee que es: **la franja en la que se calla**.
 *
 * Un contacto que llega dentro del silencio NO se descarta ni se envía tarde: la
 * inscripción espera al FINAL de la franja (así un lead que escribe a las 02:00
 * recibe su mensaje a las 06:20, cuando el silencio termina).
 *
 * Dos niveles:
 *  - Ventana del WORKFLOW (`workflow.sendWindow`): calla todos los pasos de
 *    ENVÍO del flujo (mensaje/plantilla/media/email/reseña/IA).
 *  - Nodo "Ventana horaria" (`type: 'window'`): retiene el flujo entero en ese
 *    punto mientras dure el silencio, envíe o no el paso siguiente.
 *
 * Todo se calcula en HORA LOCAL del proceso, que index.js fija en
 * America/Guayaquil (ver zona-horaria del proyecto). Funciones PURAS y testeables.
 */

const MINUTES_PER_DAY = 1440;
const DAY_MS = 24 * 60 * 60 * 1000;
// Tramos de silencio encadenados que se saltan como mucho al buscar el próximo
// hueco. Con silencios diarios, 16 saltos cubren más de una semana.
const MAX_SLOT_HOPS = 16;

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
 * ¿La ventana está ACTIVA (calla algo)? Una ventana en modo 'any', sin días o
 * con horas inválidas no calla nada: el flujo trabaja 24/7 como siempre.
 */
function isWindowActive(win) {
  if (!win || win.mode !== 'specific') return false;
  if (!normalizeDays(win.days).length) return false;
  return parseHHMM(win.from) !== null && parseHHMM(win.to) !== null;
}

/**
 * Duración del silencio en minutos. `from === to` = día completo (1440); si
 * `from > to` la franja CRUZA la medianoche (p.ej. 23:00→06:20) y el día
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
 * Tramo de silencio que arranca el día `dayStart` (Date a las 00:00), o null si
 * ese día de la semana no está marcado. Devuelve { start, end } (end exclusivo).
 */
function slotForDay(win, dayStart, fromMin, duration) {
  const days = normalizeDays(win.days);
  if (!days.includes(dayStart.getDay())) return null;
  const start = new Date(dayStart.getTime());
  start.setMinutes(fromMin);
  return { start, end: new Date(start.getTime() + duration * 60000) };
}

/**
 * Tramo de silencio que CONTIENE a `date`, o null si en ese instante se puede
 * enviar. Mira también el tramo que arrancó ayer, por las franjas que cruzan la
 * medianoche (un silencio 23:00→06:20 del lunes sigue vivo el martes a las 03:00).
 */
function quietSlotAt(win, date) {
  if (!isWindowActive(win)) return null;
  const fromMin = parseHHMM(win.from);
  const duration = windowDurationMinutes(fromMin, parseHHMM(win.to));
  const t = date.getTime();
  const today = startOfLocalDay(date);
  for (let i = -1; i <= 0; i += 1) {
    const slot = slotForDay(win, new Date(today.getTime() + i * DAY_MS), fromMin, duration);
    if (slot && t >= slot.start.getTime() && t < slot.end.getTime()) return slot;
  }
  return null;
}

/**
 * ¿`date` cae dentro del SILENCIO? Una ventana inactiva devuelve false (no calla
 * nada). Fin de franja EXCLUSIVO: a las 06:20 de un silencio 23:00–06:20 ya se
 * puede enviar.
 */
function isQuietTime(win, date = new Date()) {
  return quietSlotAt(win, date) !== null;
}

/**
 * Momento en el que el flujo puede ENVIAR:
 *  - `from` si en ese instante no hay silencio (o la ventana no calla nada),
 *  - el FINAL del silencio si está dentro (saltando tramos encadenados, p.ej.
 *    un silencio diario que empalma con el del día siguiente),
 *  - `null` si el silencio es permanente (los 7 días, 24 h): no hay hueco
 *    posible. Quien llame debe decidir qué hacer; nunca dejar preso al contacto.
 * PURA: no toca el reloj salvo por el `from` que se le pasa.
 */
function nextAllowedTime(win, from = new Date()) {
  if (!isWindowActive(win)) return from;
  let t = new Date(from);
  for (let i = 0; i <= MAX_SLOT_HOPS; i += 1) {
    const slot = quietSlotAt(win, t);
    if (!slot) return t;
    t = new Date(slot.end.getTime());
  }
  return null;
}

/** ¿El silencio cubre TODO (7 días, 24 h)? Configuración imposible de cumplir. */
function isAlwaysQuiet(win) {
  if (!isWindowActive(win)) return false;
  const fromMin = parseHHMM(win.from);
  return normalizeDays(win.days).length === 7
    && windowDurationMinutes(fromMin, parseHHMM(win.to)) === MINUTES_PER_DAY;
}

/** Texto de la ventana para el registro ("todos los días de 23:00 a 06:20"). */
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
  isQuietTime,
  nextAllowedTime,
  isAlwaysQuiet,
  describeWindow,
};
