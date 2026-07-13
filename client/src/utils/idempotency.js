/**
 * Clave de idempotencia por INTENCIÓN de pago.
 *
 * Contrato con el backend (ver server/utils/idempotency.js):
 *   - se envía en el header `Idempotency-Key`;
 *   - la MISMA clave con el MISMO contenido devuelve el pago ya registrado (replay), así que
 *     un doble clic o un reintento de red no duplican banco, asiento ni aplicación a la CxP;
 *   - la MISMA clave con contenido DISTINTO responde 409.
 *
 * De ahí las reglas de uso en la UI:
 *   - se genera UNA clave al abrir la intención de pago;
 *   - se REUTILIZA si el usuario reintenta esa misma intención (p.ej. tras un error de red);
 *   - se genera una NUEVA al cambiar importe, banco, fecha u obligación (es otra intención);
 *   - se descarta tras el éxito (el siguiente pago es una intención nueva).
 */
export function newIdempotencyKey() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `idem-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Config de axios con la clave en el header. */
export const withIdempotencyKey = (key) => ({ headers: { 'Idempotency-Key': key } });
