/**
 * Fecha EFECTIVA de pago para proyección de flujo de caja.
 *
 * Reglas (acordadas con la operación de la clínica):
 *   - De lunes a SÁBADO se considera día válido para mover dinero: un vencimiento en
 *     sábado NO se desplaza.
 *   - El DOMINGO sí se proyecta al lunes siguiente.
 *   - La fecha de vencimiento pactada (`dueDate`) es la fecha LEGAL y NUNCA se modifica.
 *     El desplazamiento es una vista de PROYECCIÓN, no un cambio del dato: por eso esta
 *     utilidad es pura y no escribe en la base, y el consumidor muestra ambas fechas.
 *   - `plannedPaymentDate` (cuándo la clínica planea pagar de verdad) PREVALECE sobre el
 *     vencimiento, pero SOLO para la proyección: no altera el `dueDate` legal.
 *
 * No incluye feriados: no existe todavía un catálogo formal de feriados en el sistema, así
 * que no se inventa uno. `nextBusinessDay(date, { holidays })` ya acepta inyectarlos como
 * claves 'YYYY-MM-DD' para cuando ese catálogo exista.
 */

const SUNDAY = 0;

function toDate(value) {
  if (!value) return null;
  const d = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Clave YYYY-MM-DD en hora local (la app corre en America/Guayaquil). */
function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** ¿Es día hábil para mover dinero? Lunes a sábado sí; domingo (y feriados) no. */
function isBusinessDay(date, { holidays } = {}) {
  const d = toDate(date);
  if (!d) return false;
  if (d.getDay() === SUNDAY) return false;
  return !(holidays && new Set(holidays).has(dayKey(d)));
}

/**
 * Siguiente día hábil (>= la fecha dada). Solo el domingo (y los feriados que se inyecten)
 * se desplazan; el sábado se mantiene.
 * @param {Date|string} date
 * @param {{ holidays?: Iterable<string> }} [opts] feriados como 'YYYY-MM-DD'
 * @returns {Date|null}
 */
function nextBusinessDay(date, { holidays } = {}) {
  const d = toDate(date);
  if (!d) return null;
  const feriados = holidays ? new Set(holidays) : null;
  // Cota de seguridad: nunca desplazar más de 10 días (evita bucles con feriados mal cargados).
  for (let i = 0; i < 10; i += 1) {
    const esDomingo = d.getDay() === SUNDAY;
    const esFeriado = feriados && feriados.has(dayKey(d));
    if (!esDomingo && !esFeriado) return d;
    d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Fecha efectiva de pago de un documento de cartera (CxC/CxP) u obligación.
 *
 * Prioridad de la BASE de proyección:
 *   1. `plannedPaymentDate` — cuándo se planea pagar (solo afecta a la proyección);
 *   2. `dueDate`            — vencimiento legal;
 *   3. `issueDate`          — documentos al contado.
 * Sobre esa base se aplica el desplazamiento a día hábil. El `dueDate` devuelto es SIEMPRE
 * el legal, sin tocar.
 *
 * @returns {{ dueDate: Date|null, plannedPaymentDate: Date|null, effectiveDate: Date|null, shifted: boolean }}
 */
function effectivePaymentDate(doc, { holidays } = {}) {
  const due = toDate(doc?.dueDate);
  const planned = toDate(doc?.plannedPaymentDate);
  const base = planned || due || toDate(doc?.issueDate);
  if (!base) return { dueDate: due, plannedPaymentDate: planned, effectiveDate: null, shifted: false };
  const effective = nextBusinessDay(base, { holidays });
  return {
    dueDate: due,
    plannedPaymentDate: planned,
    effectiveDate: effective,
    shifted: effective.getTime() !== base.getTime(),
  };
}

module.exports = { nextBusinessDay, effectivePaymentDate, isBusinessDay };
