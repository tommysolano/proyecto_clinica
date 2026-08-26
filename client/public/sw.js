/* eslint-env serviceworker */
/**
 * Service worker de Vikingo — lo mínimo para que la app se pueda INSTALAR en el
 * móvil (Android exige un service worker con manejador `fetch` para ofrecer
 * "Añadir a pantalla de inicio") y para que abra aunque no haya red.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * POR QUÉ ES TAN CORTO Y NO USA WORKBOX
 *
 * Un service worker que precachea el `index.html` es la forma más rápida de
 * dejar a la clínica trabajando contra una versión vieja del sistema sin que
 * nadie se entere. Este proyecto ya arrastró ese problema por otro camino:
 * cada despliegue renombra los ficheros con hash nuevo y borra los anteriores,
 * así que una pestaña con el `index.html` ANTIGUO pide chunks que ya no existen
 * (404) y la pantalla se queda en blanco — de ahí `utils/lazyPage.js`. Si el
 * service worker sirviera ese `index.html` viejo desde caché, la recarga de
 * emergencia volvería a recibir el mismo HTML caducado y el usuario quedaría
 * atrapado.
 *
 * Por eso aquí la regla es:
 *   · navegación (el HTML) → SIEMPRE red primero; la caché es solo el paracaídas
 *     de "estoy sin cobertura".
 *   · /assets/*  → caché primero, porque llevan hash en el nombre: si el
 *     contenido cambia, cambia el nombre. Nunca sirven algo caducado.
 *   · /api/ y /socket.io/ → NUNCA se tocan. Son datos clínicos y de facturación:
 *     una respuesta cacheada aquí sería un error médico o contable.
 *
 * Para forzar que TODOS los dispositivos tiren su caché, sube VERSION.
 */

const VERSION = 'vikingo-v1';
const CACHE_SHELL = `${VERSION}-shell`;
const CACHE_ASSETS = `${VERSION}-assets`;
const INDEX = '/index.html';

// Tope de ficheros con hash guardados. Cada despliegue deja atrás los del
// anterior (ya inservibles) y sin tope la caché crecería sin fin en el móvil.
const MAX_ASSETS = 400;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_SHELL);
      // `cache: 'reload'` evita guardar una copia que ya venía caducada del
      // caché HTTP del navegador.
      await cache.add(new Request(INDEX, { cache: 'reload' })).catch(() => {});
      // Sin esperar a que se cierren las pestañas: tras un despliegue, la
      // versión nueva debe mandar ya.
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) {
        if (!key.startsWith(VERSION)) await caches.delete(key);
      }
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try {
    url = new URL(req.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  // Datos: jamás desde caché. Ni la API ni el socket ni los adjuntos del chat.
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/socket.io/')) return;

  // El HTML, siempre de la red mientras haya red (ver cabecera del archivo).
  if (req.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresca = await fetch(req);
          if (fresca.ok) {
            const cache = await caches.open(CACHE_SHELL);
            cache.put(INDEX, fresca.clone());
          }
          return fresca;
        } catch {
          const guardada = await caches.match(INDEX, { cacheName: CACHE_SHELL });
          return guardada || Response.error();
        }
      })(),
    );
    return;
  }

  // Ficheros con hash: inmutables, caché primero (arranque instantáneo).
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      (async () => {
        const guardada = await caches.match(req, { cacheName: CACHE_ASSETS });
        if (guardada) return guardada;
        const fresca = await fetch(req);
        if (fresca.ok) {
          const cache = await caches.open(CACHE_ASSETS);
          await cache.put(req, fresca.clone());
          recortarCache(cache);
        }
        return fresca;
      })(),
    );
  }
  // Todo lo demás (logo, iconos, fuentes) lo gestiona el navegador como siempre.
});

/** Deja la caché de assets en MAX_ASSETS entradas, tirando las más antiguas. */
async function recortarCache(cache) {
  const claves = await cache.keys();
  if (claves.length <= MAX_ASSETS) return;
  for (const clave of claves.slice(0, claves.length - MAX_ASSETS)) {
    await cache.delete(clave);
  }
}
