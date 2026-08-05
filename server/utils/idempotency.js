/**
 * IDEMPOTENCIA DE OPERACIONES (pagos y creación de declaraciones).
 *
 * Reutiliza y generaliza el mecanismo que ya existía en `Payment.idempotencyKey`:
 * el cliente manda una CLAVE por intención (header `Idempotency-Key`, con compatibilidad
 * temporal con `body.idempotencyKey`) y el backend garantiza que esa intención se ejecute
 * UNA sola vez, aunque haya doble clic, reintento de red o dos peticiones en paralelo.
 *
 * Además de la clave se guarda una HUELLA (fingerprint) del contenido de la solicitud:
 *
 *   - misma clave + mismo contenido  → REPLAY: se devuelve el resultado ya creado, sin
 *     crear otro asiento, otra aplicación ni volver a tocar la CxP.
 *   - misma clave + contenido DISTINTO → 409 Conflict: la clave ya se usó para otra
 *     operación. No se modifica ningún dato.
 *   - claves distintas → operaciones distintas: dos pagos reales de USD 100 en momentos
 *     diferentes se registran los dos.
 *
 * La huella se calcula sobre el contenido de la SOLICITUD (normalizado y con las claves
 * ordenadas, para que el orden del JSON no la cambie), nunca sobre datos derivados por el
 * backend, timestamps ni el usuario que la envió.
 */
const crypto = require('crypto');

const conflict = (msg) => Object.assign(new Error(msg), { status: 409 });

/**
 * Clave de idempotencia de la petición. Prioriza el header `Idempotency-Key`; acepta
 * `body.idempotencyKey` por compatibilidad. Se normaliza a una sola clave (o null).
 */
function readIdempotencyKey(req) {
  const fromHeader = req?.headers?.['idempotency-key']
    || (typeof req?.get === 'function' ? req.get('Idempotency-Key') : null);
  const raw = fromHeader || req?.body?.idempotencyKey || '';
  const key = String(raw).trim();
  if (!key) return null;
  /**
   * Una clave larga NO es un error del usuario: es solo una clave. Antes se lanzaba aquí un 400,
   * y como los nueve controladores que usan esta función la llaman ANTES de su `try` —y Express 4
   * no captura el rechazo de un handler `async`— la petición se quedaba SIN RESPUESTA para
   * siempre: el navegador giraba hasta que se cortaba la conexión y la pantalla decía «Error»
   * sin más detalle.
   *
   * Caso real: pagar DOS facturas de compra a la vez. La clave que arma el cliente lleva un
   * segmento por documento aplicado, así que con dos superaba los 200 caracteres (206) y el
   * pago se quedaba colgado; con una sola factura entraba por debajo del límite y funcionaba.
   *
   * Se deriva una clave corta y ESTABLE en su lugar: la misma clave larga produce siempre la
   * misma corta, de modo que el replay y el 409 por huella distinta siguen comportándose igual.
   */
  if (key.length > 200) return `h:${crypto.createHash('sha256').update(key).digest('hex')}`;
  return key;
}

/** Serializa de forma ESTABLE: claves ordenadas, sin depender del orden del JSON. */
function stableStringify(value) {
  if (value === null || value === undefined) return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Importe normalizado a 2 decimales (o null): '100' y 100 producen la misma huella. */
const num = (v) => (v === null || v === undefined || v === '' ? null : +(Number(v) || 0).toFixed(2));
/** Fecha normalizada a ISO (o null). Se usa la fecha ENVIADA, no la resuelta por defecto. */
const date = (v) => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString();
};
/** Id normalizado a string (o null). */
const id = (v) => (v ? String(v) : null);

/** Huella estable (sha256) del contenido relevante de una solicitud. */
function fingerprint(payload) {
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

/**
 * Compara la huella de una solicitud contra la de una operación ya registrada con la misma
 * clave. Igual → replay; distinta → 409 (sin tocar nada).
 * @param {string} existingFingerprint huella guardada
 * @param {string} incomingFingerprint huella de esta solicitud
 * @param {string} what descripción de la operación para el mensaje
 */
function assertSameFingerprint(existingFingerprint, incomingFingerprint, what) {
  // Registros anteriores a la huella (legacy): no se puede comparar → se trata como replay
  // (el comportamiento previo del sistema) en vez de bloquear una operación válida.
  if (!existingFingerprint) return;
  if (existingFingerprint !== incomingFingerprint) {
    throw conflict(
      `La clave de idempotencia ya fue utilizada para OTRA operación (${what}). `
      + 'Use una clave nueva para una operación distinta, o repita exactamente la misma solicitud.'
    );
  }
}

/**
 * La clave de idempotencia es única POR CLÍNICA, no por obligación: los índices únicos
 * colisionan entre documentos. Antes de comparar huellas hay que comprobar que la operación
 * ya registrada con esa clave pertenece a la MISMA obligación (mismo rol, misma declaración).
 *
 * Si pertenece a otra ⇒ 409. Nunca se devuelve el pago de la otra obligación como si fuera
 * el de esta: eso reproduciría un pago ajeno.
 *
 * @param {*} existingTargetId obligación a la que ya se aplicó la clave
 * @param {*} incomingTargetId obligación de esta solicitud
 * @param {string} what descripción de la operación para el mensaje
 */
function assertSameTarget(existingTargetId, incomingTargetId, what) {
  if (String(existingTargetId) !== String(incomingTargetId)) {
    throw conflict(
      `La clave de idempotencia ya fue utilizada para ${what} de OTRA obligación `
      + `(${existingTargetId}). Cada obligación es una operación distinta: use una clave nueva.`
    );
  }
}

module.exports = {
  readIdempotencyKey,
  fingerprint,
  stableStringify,
  assertSameFingerprint,
  assertSameTarget,
  normalize: { num, date, id },
  conflict,
};
