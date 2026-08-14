/**
 * «SI VOY A OTRA PÁGINA SE QUEDA EN BLANCO Y HAY QUE RECARGAR».
 *
 * Cada despliegue renombra los ficheros de las páginas (llevan un hash) y borra
 * los anteriores. Una pestaña abierta desde antes sigue pidiendo los viejos: el
 * `import()` de la página da 404, la promesa se rompe y —sin nadie que recoja el
 * error— React desmonta el árbol entero y deja la pantalla en blanco para siempre.
 *
 * `cargarPagina` (client/src/utils/lazyPage.js) recarga UNA vez para coger la
 * versión nueva. Vive en la suite del servidor porque el cliente no tiene corredor
 * de tests y la función es pura (el almacén y la recarga se inyectan).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'utils', 'lazyPage.js')
).href;

let cargarPagina;
let MARCA_RECARGA;

test.before(async () => {
  ({ cargarPagina, MARCA_RECARGA } = await import(MODULE));
});

/** sessionStorage de mentira. */
const almacen = (inicial = {}) => {
  const datos = { ...inicial };
  return {
    getItem: (k) => (k in datos ? datos[k] : null),
    setItem: (k, v) => { datos[k] = String(v); },
    removeItem: (k) => { delete datos[k]; },
    datos,
  };
};

/** ¿La promesa se quedó sin resolver (porque la pestaña se está recargando)? */
const seQuedaColgada = async (p) => {
  const testigo = Symbol('colgada');
  const r = await Promise.race([p, new Promise((res) => setTimeout(() => res(testigo), 30))]);
  return r === testigo;
};

test('la página carga bien: borra la marca para que el próximo despliegue tenga su recarga', async () => {
  const storage = almacen({ [MARCA_RECARGA]: '1' });
  let recargas = 0;
  const mod = await cargarPagina(async () => ({ default: 'Pagina' }), {
    storage,
    recargar: () => { recargas++; },
  });
  assert.equal(mod.default, 'Pagina');
  assert.equal(storage.getItem(MARCA_RECARGA), null);
  assert.equal(recargas, 0);
});

test('el fichero ya no existe (despliegue): recarga UNA vez y no resuelve mientras tanto', async () => {
  const storage = almacen();
  let recargas = 0;
  const p = cargarPagina(
    async () => { throw new TypeError('Failed to fetch dynamically imported module'); },
    { storage, recargar: () => { recargas++; } }
  );
  assert.equal(await seQuedaColgada(p), true, 'no debe pintar nada mientras se recarga');
  assert.equal(recargas, 1);
  assert.equal(storage.getItem(MARCA_RECARGA), '1');
});

test('si vuelve a fallar tras la recarga, no entra en bucle: propaga el error', async () => {
  const storage = almacen({ [MARCA_RECARGA]: '1' });
  let recargas = 0;
  await assert.rejects(
    cargarPagina(
      async () => { throw new TypeError('Failed to fetch dynamically imported module'); },
      { storage, recargar: () => { recargas++; } }
    ),
    /Failed to fetch/
  );
  assert.equal(recargas, 0, 'la segunda vez la pinta la barrera de error, no se recarga otra vez');
});

test('sin almacén (modo privado extremo): tampoco recarga en bucle', async () => {
  let recargas = 0;
  await assert.rejects(
    cargarPagina(async () => { throw new Error('boom'); }, { storage: null, recargar: () => { recargas++; } }),
    /boom/
  );
  assert.equal(recargas, 0);
});
