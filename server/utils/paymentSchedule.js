/**
 * Fecha EFECTIVA de pago/cobro para la proyección de flujo de caja.
 *
 * Reglas (acordadas con la operación de la clínica):
 *   - De lunes a SÁBADO se considera día válido para mover dinero: un vencimiento en
 *     sábado NO se desplaza.
 *   - El DOMINGO sí se proyecta al lunes siguiente.
 *   - La fecha de vencimiento pactada (`dueDate`) es la fecha LEGAL y NUNCA se modifica.
 *     El desplazamiento es una vista de PROYECCIÓN, no un cambio del dato: por eso esta
 *     utilidad es pura y no escribe en la base, y el consumidor muestra ambas fechas.
 *   - `plannedPaymentDate` (cuándo la clínica planea pagar/cobrar de verdad) PREVALECE
 *     sobre el vencimiento, pero SOLO para la proyección: no altera el `dueDate` legal.
 *
 * El calendario es CONFIGURABLE por clínica (`CashFlowConfig`) sin cambiar la regla por
 * defecto: `{ includeSaturdays = true }` mantiene el comportamiento acordado. Si una
 * clínica apaga los sábados, el sábado pasa a ser no hábil y se desplaza como el domingo.
 *
 * Feriados: no se inventan. No existe todavía un catálogo formal de feriados, así que la
 * lista llega vacía; `holidays` ya acepta claves 'YYYY-MM-DD' para cuando ese catálogo
 * exista (CashFlowConfig.holidays lo deja preparado).
 */

const SUNDAY = 0;
const SATURDAY = 6;

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Clave YYYY-MM-DD en hora local (la app corre en America/Guayaquil). */
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * ¿Es día hábil para mover dinero?
 * Por defecto: lunes a sábado sí; domingo no. Con `includeSaturdays: false` el sábado
 * tampoco. Los feriados que se inyecten nunca son hábiles.
 */
function isBusinessDay(date, { holidays, includeSaturdays = true } = {}) {
  const d = toDate(date);
  if (!d) return false;
  const dow = d.getDay();
  if (dow === SUNDAY) return false;
  if (dow === SATURDAY && !includeSaturdays) return false;
  return !(holidays && new Set(holidays).has(dayKey(d)));
}

/**
 * Siguiente día hábil (>= la fecha dada).
 * @param {Date|string} date
 * @param {{ holidays?: Iterable<string>, includeSaturdays?: boolean }} [opts]
 * @returns {Date|null}
 */
function nextBusinessDay(date, opts = {}) {
  const d = toDate(date);
  if (!d) return null;
  // Cota de seguridad: nunca desplazar más de 10 días (evita bucles con feriados mal cargados).
  for (let i = 0; i < 10; i += 1) {
    if (isBusinessDay(d, opts)) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Fecha efectiva de movimiento de dinero de un documento de cartera (CxC/CxP) u obligación.
 *
 * Prioridad de la BASE de proyección:
 *   1. `plannedPaymentDate` — cuándo se planea pagar/cobrar (solo afecta a la proyección);
 *   2. `dueDate`            — vencimiento legal;
 *   3. `issueDate`          — fallback documentado, para históricos sin vencimiento.
 * Sobre esa base se aplica el desplazamiento a día hábil. El `dueDate` devuelto es SIEMPRE
 * el legal, sin tocar.
 *
 * En una CxC el campo físico `plannedPaymentDate` significa "fecha planificada de COBRO"
 * (Receivable lo expone además como `plannedCollectionDate`); es el mismo concepto —cuándo
 * se mueve el dinero— en el otro sentido, y por eso comparte almacenamiento en vez de tener
 * dos fuentes de verdad que puedan discrepar.
 *
 * @returns {{ dueDate, plannedPaymentDate, effectiveDate, shifted, basedOn }}
 */
function effectivePaymentDate(doc, opts = {}) {
  const due = toDate(doc?.dueDate);
  const planned = toDate(doc?.plannedPaymentDate ?? doc?.plannedCollectionDate ?? doc?.plannedDate);
  const issue = toDate(doc?.issueDate);
  const base = planned || due || issue;
  const basedOn = planned ? 'PLANIFICADA' : (due ? 'VENCIMIENTO' : (issue ? 'EMISION' : null));
  if (!base) {
    return { dueDate: due, plannedPaymentDate: planned, effectiveDate: null, shifted: false, basedOn: null };
  }
  const effective = nextBusinessDay(base, opts);
  return {
    dueDate: due,
    plannedPaymentDate: planned,
    effectiveDate: effective,
    shifted: effective.getTime() !== base.getTime(),
    basedOn,
  };
}

module.exports = { nextBusinessDay, effectivePaymentDate, isBusinessDay, dayKey };
