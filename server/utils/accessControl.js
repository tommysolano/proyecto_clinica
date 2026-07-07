const AccessBlock = require('../models/AccessBlock');

// Ecuador (sin horario de verano). La evaluación de las reglas se hace contra
// la hora local de Ecuador, no la del servidor (que suele estar en UTC).
const TZ = 'America/Guayaquil';

// Caché en memoria: el middleware `auth` consulta esto en CADA petición, así que
// evitamos ir a la base de datos cada vez. Se refresca cada TTL ms y también de
// forma explícita cuando cambian las reglas (invalidate()).
const TTL_MS = 30 * 1000;
let cache = { rules: [], ts: 0 };

async function getRules() {
  const now = Date.now();
  if (cache.ts && now - cache.ts < TTL_MS) return cache.rules;
  const rules = await AccessBlock.find({ active: true }).lean();
  cache = { rules, ts: now };
  return rules;
}

function invalidate() {
  cache = { rules: [], ts: 0 };
}

// Descompone la fecha/hora actual en componentes de la hora local de Ecuador.
function localParts(d = new Date()) {
  // Truco estándar: reinterpretar el instante en la zona objetivo.
  const local = new Date(d.toLocaleString('en-US', { timeZone: TZ }));
  const y = local.getFullYear();
  const m = String(local.getMonth() + 1).padStart(2, '0');
  const day = String(local.getDate()).padStart(2, '0');
  return {
    weekday: local.getDay(),                 // 0=Domingo … 6=Sábado
    prevWeekday: (local.getDay() + 6) % 7,   // día anterior
    minutes: local.getHours() * 60 + local.getMinutes(),
    dateStr: `${y}-${m}-${day}`,
  };
}

const toMin = (hhmm) => {
  const [h, m] = String(hhmm || '0:0').split(':').map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
};

const prevDateStr = (dateStr) => {
  const d = new Date(`${dateStr}T12:00:00`);
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
};

// ¿Aplica la regla al día indicado (por día de semana o por fecha)?
function dayMatches(rule, weekday, dateStr) {
  if (rule.mode === 'date') return rule.date === dateStr;
  const wds = rule.weekdays && rule.weekdays.length ? rule.weekdays : [0, 1, 2, 3, 4, 5, 6];
  return wds.includes(weekday);
}

// ¿La regla bloquea el acceso en este momento (lp = localParts)?
function ruleBlocksNow(rule, lp) {
  if (rule.allDay) return dayMatches(rule, lp.weekday, lp.dateStr);

  const start = toMin(rule.startTime);
  const end = toMin(rule.endTime);
  if (start === end) return false; // ventana nula

  if (start < end) {
    // Ventana dentro del mismo día (ej. 08:00–12:00).
    return dayMatches(rule, lp.weekday, lp.dateStr) && lp.minutes >= start && lp.minutes < end;
  }

  // Ventana que cruza la medianoche (ej. 19:00–06:00). El bloque "pertenece" al
  // día en que empieza.
  // Tramo 1: desde `start` hasta medianoche → mismo día de hoy.
  if (lp.minutes >= start && dayMatches(rule, lp.weekday, lp.dateStr)) return true;
  // Tramo 2: desde medianoche hasta `end` → el día de inicio fue "ayer".
  if (lp.minutes < end) {
    if (rule.mode === 'date') return rule.date === prevDateStr(lp.dateStr);
    const wds = rule.weekdays && rule.weekdays.length ? rule.weekdays : [0, 1, 2, 3, 4, 5, 6];
    return wds.includes(lp.prevWeekday);
  }
  return false;
}

/**
 * ¿El usuario tiene bloqueado el acceso ahora mismo?
 * El super-admin y los usuarios exceptuados nunca se bloquean.
 * @returns {Promise<{blocked:boolean, rule?:object}>}
 */
async function isAccessBlocked(user) {
  if (!user || user.isSuperAdmin) return { blocked: false };
  const rules = await getRules();
  if (!rules.length) return { blocked: false };
  const lp = localParts();
  const uid = String(user._id);
  for (const rule of rules) {
    if ((rule.exceptUsers || []).some((u) => String(u) === uid)) continue;
    if (ruleBlocksNow(rule, lp)) return { blocked: true, rule };
  }
  return { blocked: false };
}

// Mensaje amigable para mostrar al usuario bloqueado.
function blockMessage(rule) {
  const base = 'El acceso al sistema está temporalmente bloqueado';
  if (!rule) return `${base}.`;
  if (rule.name) return `${base}: ${rule.name}.`;
  return `${base} en este horario. Contacta al administrador.`;
}

module.exports = {
  isAccessBlocked,
  invalidate,
  getRules,
  blockMessage,
  // Exportado para pruebas.
  _internals: { ruleBlocksNow, localParts, toMin, dayMatches },
};
