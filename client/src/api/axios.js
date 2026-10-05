import axios from 'axios';

// En producción (Vercel) VITE_API_URL apunta al backend de Render.
// En desarrollo el proxy de Vite redirige '/api' → localhost:5000.
const BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const api = axios.create({ baseURL: BASE });

/**
 * AVISO DE CONEXIÓN LENTA.
 *
 * Con internet débil, la app se quedaba con el spinner girando sin decir nada y
 * el usuario no sabía si el sistema estaba colgado. Aquí se lleva la cuenta de
 * las peticiones que llevan más de SLOW_MS esperando; el componente
 * `SlowNetworkNotice` se suscribe y muestra un aviso discreto mientras haya
 * alguna. No cambia ninguna petición: solo las observa.
 */
const SLOW_MS = 4000;
const slowListeners = new Set();
let slowCount = 0;
const emitSlow = () => slowListeners.forEach((fn) => fn(slowCount));
export function subscribeSlowRequests(fn) {
  slowListeners.add(fn);
  fn(slowCount);
  return () => slowListeners.delete(fn);
}
function trackStart(config) {
  config.__slowTimer = setTimeout(() => {
    config.__slowMarked = true;
    slowCount += 1;
    emitSlow();
  }, SLOW_MS);
}
function trackEnd(config) {
  if (!config) return;
  clearTimeout(config.__slowTimer);
  if (config.__slowMarked) {
    config.__slowMarked = false;
    slowCount = Math.max(0, slowCount - 1);
    emitSlow();
  }
}

/**
 * CATÁLOGOS QUE CASI NO CAMBIAN, UN MINUTO EN MEMORIA.
 *
 * Doctores, enfermería, sucursales, servicios de agenda, agentes… los pedía de
 * nuevo CADA pantalla al abrirse (la agenda sola pide cuatro), así que navegar
 * por el sistema repetía las mismas descargas una y otra vez. Con internet débil
 * cada una se notaba. Ahora la misma lectura, con la misma sesión y los mismos
 * parámetros, se sirve de memoria durante CATALOG_TTL_MS; dos pantallas que la
 * piden a la vez comparten la misma petición.
 *
 * Es una lista CERRADA a propósito (nada de datos clínicos ni de dinero), y
 * CUALQUIER escritura que salga bien (POST/PUT/PATCH/DELETE) vacía la memoria:
 * quien da de alta a un doctor lo ve al instante en la agenda.
 */
const CATALOG_TTL_MS = 60 * 1000;
const CATALOG_URLS = [
  /^\/users\/doctors$/,
  /^\/users\/nurses$/,
  /^\/appointment-service-items$/,
  /^\/call-center\/agents$/,
  /^\/chats\/opportunities\/catalog$/,
];
const catalogCache = new Map(); // clave -> { at, promise }
function catalogKey(config) {
  if ((config.method || 'get').toLowerCase() !== 'get' || config.responseType) return null;
  const url = String(config.url || '');
  const params = config.params || {};
  const cacheable = CATALOG_URLS.some((re) => re.test(url))
    // Solo la lista corta de nombres de sucursales, no la ficha completa.
    || (url === '/clinics' && params.scope === 'names' && Object.keys(params).length === 1);
  if (!cacheable) return null;
  return `${localStorage.getItem('token') || ''}|${url}|${JSON.stringify(params)}`;
}
const cloneData = (data) => {
  try {
    return typeof structuredClone === 'function' ? structuredClone(data) : JSON.parse(JSON.stringify(data));
  } catch {
    return data;
  }
};

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const key = catalogKey(config);
  if (key) {
    const network = axios.getAdapter(config.adapter || axios.defaults.adapter);
    config.adapter = (cfg) => {
      const hit = catalogCache.get(key);
      if (!hit || Date.now() - hit.at > CATALOG_TTL_MS) {
        const promise = network(cfg);
        catalogCache.set(key, { at: Date.now(), promise });
        // Un error no se recuerda: la próxima vez se vuelve a pedir.
        promise.catch(() => { if (catalogCache.get(key)?.promise === promise) catalogCache.delete(key); });
      }
      // Cada pantalla recibe su PROPIA copia: si una ordena o modifica la lista,
      // no le cambia la lista a las demás.
      return catalogCache.get(key).promise.then((res) => ({ ...res, config: cfg, data: cloneData(res.data) }));
    };
  }
  trackStart(config);
  return config;
});

/**
 * MENSAJE SIEMPRE LEGIBLE.
 *
 * Media aplicación muestra el error con `err.response?.data?.message || 'Error'`. Ese patrón
 * funciona cuando el backend responde JSON, pero deja al usuario a ciegas justo cuando más
 * falta hace: si la petición se corta, si nginx devuelve SU propia página de 502/504 (HTML, sin
 * `message`) o si el proceso se reinicia a mitad, la pantalla dice literalmente «Error» y no hay
 * nada más que mirar. Caso real: un pago con cheque que se quedaba pensando y terminaba en un
 * «Error» sin causa.
 *
 * Aquí se rellena ese hueco una sola vez, para toda la app: el mensaje dice QUÉ pasó y —lo más
 * importante en pagos y cobros— si la operación pudo haber quedado registrada igualmente.
 */
const MENSAJES_HTTP = {
  413: 'Los datos o el archivo enviados son demasiado grandes para el servidor.',
  429: 'Demasiadas peticiones seguidas. Espera unos segundos y vuelve a intentarlo.',
  500: 'El servidor falló al procesar la solicitud. El detalle quedó en el registro del servidor.',
  502: 'El servidor no respondió (502). Puede estar reiniciándose: espera unos segundos y '
     + 'COMPRUEBA si la operación quedó registrada antes de repetirla.',
  503: 'El servidor no está disponible en este momento (503). Inténtalo de nuevo en un minuto.',
  504: 'El servidor tardó demasiado y se cortó la conexión (504). La operación puede haberse '
     + 'registrado igualmente: COMPRUÉBALO antes de repetirla.',
};

function mensajeDeError(error) {
  if (!error.response) {
    if (error.code === 'ECONNABORTED') {
      return 'La petición se canceló por tiempo de espera. Comprueba si la operación quedó registrada antes de repetirla.';
    }
    return 'No se recibió respuesta del servidor (conexión interrumpida o servidor caído). '
      + 'Comprueba si la operación quedó registrada antes de repetirla.';
  }
  return MENSAJES_HTTP[error.response.status]
    || `El servidor respondió con un error ${error.response.status}.`;
}

/**
 * UN REINTENTO PARA LAS LECTURAS QUE SE CORTAN POR LA RED.
 *
 * En una conexión inestable (wifi de la clínica, datos del celular) una petición
 * se pierde a veces sin respuesta del servidor, y la pantalla quedaba vacía o
 * con un error hasta que el usuario recargaba. Las LECTURAS (GET) son seguras de
 * repetir, así que se reintentan UNA vez, segundo y medio después. Nunca se
 * repite una escritura (POST/PUT/DELETE): podría duplicar un cobro o un envío.
 * Tampoco se repite lo que se canceló a propósito ni lo que sí respondió.
 */
const RETRY_DELAY_MS = 1500;
function isRetryableRead(error) {
  const config = error.config;
  if (!config || config.__retried || error.response) return false;
  if ((config.method || 'get').toLowerCase() !== 'get') return false;
  if (axios.isCancel(error) || error.code === 'ERR_CANCELED') return false;
  if (config.signal?.aborted) return false;
  return true;
}

api.interceptors.response.use(
  (response) => {
    trackEnd(response.config);
    if ((response.config?.method || 'get').toLowerCase() !== 'get') catalogCache.clear();
    return response;
  },
  async (error) => {
    trackEnd(error.config);
    if (isRetryableRead(error)) {
      error.config.__retried = true;
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      return api(error.config);
    }
    const status = error.response?.status;
    const code = error.response?.data?.code;
    if (status === 403 && code === 'ACCESS_BLOCKED') {
      // Bloqueo de acceso al sistema (definido por el super-admin). Se cierra la
      // sesión y se guarda el motivo para mostrarlo en el login.
      const msg = error.response?.data?.message || 'El acceso al sistema está bloqueado en este momento.';
      localStorage.setItem('accessBlockMsg', msg);
      localStorage.removeItem('token');
      localStorage.removeItem('authMeCache');
      if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
    } else if (status === 401) {
      localStorage.removeItem('token');
      localStorage.removeItem('authMeCache');
      window.location.href = '/login';
    } else if (status === 403 && code === 'CLINIC_REQUIRED') {
      // Token válido pero sin clínica seleccionada → forzar selección
      window.location.href = '/select-clinic';
    }

    // Se garantiza `error.response.data.message` sin pisar nunca el del backend. No se toca
    // `data` cuando ya es un objeto útil (ni un Blob de una descarga fallida).
    const msg = mensajeDeError(error);
    if (!error.response) {
      error.response = { status: 0, data: { message: msg } };
    } else if (!error.response.data || typeof error.response.data !== 'object') {
      error.response.data = { message: msg };
    } else if (!error.response.data.message) {
      try { error.response.data.message = msg; } catch { /* respuesta inmutable (Blob) */ }
    }
    return Promise.reject(error);
  }
);

export default api;
