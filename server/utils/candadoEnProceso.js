/**
 * UNA SOLA PETICIÓN A LA VEZ POR CLAVE, dentro de este proceso (oct-2026).
 *
 * Las comprobaciones de «ya existe» (cita repetida, bloqueo repetido) son
 * comprobar-y-luego-crear: dos peticiones que llegan casi juntas —el doble clic
 * en un PC lento, el Enter repetido— pasan las dos la comprobación antes de que
 * ninguna haya escrito, y salen dos citas iguales. Con el candado, la segunda
 * espera su turno y entonces la comprobación sí ve lo que escribió la primera.
 *
 * Es en memoria: vale porque las peticiones HTTP las atiende un solo backend
 * (ver la memoria del backend líder). No sustituye a la comprobación, la ordena.
 */
const colas = new Map();

/**
 * Ejecuta `fn` cuando nadie más tenga la misma `clave`. Las peticiones con la
 * misma clave se atienden en fila; con claves distintas, en paralelo.
 */
async function conCandado(clave, fn) {
  const anterior = colas.get(clave) || Promise.resolve();
  let soltar;
  const turno = new Promise((r) => { soltar = r; });
  const cola = anterior.then(() => turno);
  colas.set(clave, cola);
  try {
    await anterior;
    return await fn();
  } finally {
    soltar();
    if (colas.get(clave) === cola) colas.delete(clave);
  }
}

module.exports = { conCandado };
