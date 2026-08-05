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

/**
 * Clave DERIVADA de una intención concreta: `base` identifica la sesión del formulario
 * (se genera al abrir el modal) y `parts` los datos que definen la operación (importe,
 * banco, fecha, método, documento…).
 *
 * Por qué así: la clave tiene que ser ESTABLE mientras el usuario no cambie nada —para que
 * un doble clic o un reintento de red hagan replay en vez de registrar dos pagos— y DISTINTA
 * en cuanto cambie algo, porque entonces es otra operación (si no, el backend respondería 409
 * "misma clave, otro contenido"). Reutiliza la misma huella que valida el servidor.
 */
export function intentKey(base, parts = []) {
  const suffix = parts
    .map((p) => (p === null || p === undefined ? '' : String(p)))
    .join('|')
    .replace(/[^\w.@:$-]+/g, '_');
  return `${base}:${hash(suffix)}`;
}

/**
 * Huella corta de la intención. Se RESUME en lugar de concatenar porque el texto crudo crecía
 * con cada documento aplicado (unos 45 caracteres por factura) y con dos facturas la clave
 * pasaba de 200: el servidor la rechazaba y la petición se quedaba sin respuesta. Un resumen
 * mantiene la propiedad que importa —igual contenido ⇒ igual clave, contenido distinto ⇒ clave
 * distinta— con longitud fija.
 *
 * FNV-1a de 32 bits en dos pasadas con semillas distintas (64 bits efectivos): más que
 * suficiente para distinguir las pocas variaciones de un mismo formulario, y el `base` aleatorio
 * ya garantiza que dos intenciones diferentes nunca compartan clave.
 */
function hash(text) {
  const fnv = (seed) => {
    let h = seed;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h.toString(16).padStart(8, '0');
  };
  return fnv(0x811c9dc5) + fnv(0x9e3779b9);
}
