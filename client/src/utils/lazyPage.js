/**
 * PANTALLA EN BLANCO AL NAVEGAR DESPUÉS DE UN DESPLIEGUE.
 *
 * Cada despliegue genera los ficheros de las páginas con un hash nuevo
 * (`Analytics-BNSmvEiw.js`) y borra los de la versión anterior. Una pestaña que
 * lleva abierta desde antes sigue teniendo en memoria los nombres VIEJOS: al
 * entrar en una pantalla que aún no había visitado, el `import()` pide un fichero
 * que ya no existe (404), la promesa se rompe y React desmonta el árbol entero.
 * Resultado: pantalla en blanco, y ahí se queda hasta recargar a mano.
 *
 * Aquí se recoge ese fallo y se recarga UNA vez para coger la versión nueva. La
 * marca en `sessionStorage` evita el bucle de recargas si el fallo no fuera por el
 * despliegue (sin conexión, por ejemplo), y se borra en cuanto una descarga vuelve
 * a ir bien, para que el siguiente despliegue tenga otra vez su recarga.
 *
 * Las dependencias (almacén y recarga) se pueden inyectar para poder probarlo.
 */
export const MARCA_RECARGA = 'recarga-por-version';

export function cargarPagina(importar, opciones = {}) {
  const storage = 'storage' in opciones
    ? opciones.storage
    : (typeof sessionStorage !== 'undefined' ? sessionStorage : null);
  const recargar = opciones.recargar || (() => window.location.reload());

  return importar()
    .then((mod) => {
      storage?.removeItem(MARCA_RECARGA);
      return mod;
    })
    .catch((err) => {
      // Sin almacén no hay forma de saber si ya se intentó: mejor el error visible
      // (lo pinta la barrera) que una recarga en bucle.
      if (!storage || storage.getItem(MARCA_RECARGA)) throw err;
      storage.setItem(MARCA_RECARGA, '1');
      recargar();
      // No se resuelve nunca a propósito: la pestaña se está recargando y no debe
      // pintarse nada por el camino.
      return new Promise(() => {});
    });
}
