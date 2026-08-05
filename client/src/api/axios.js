import axios from 'axios';

// En producción (Vercel) VITE_API_URL apunta al backend de Render.
// En desarrollo el proxy de Vite redirige '/api' → localhost:5000.
const BASE = import.meta.env.VITE_API_URL
  ? `${import.meta.env.VITE_API_URL}/api`
  : '/api';

const api = axios.create({ baseURL: BASE });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
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

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const code = error.response?.data?.code;
    if (status === 403 && code === 'ACCESS_BLOCKED') {
      // Bloqueo de acceso al sistema (definido por el super-admin). Se cierra la
      // sesión y se guarda el motivo para mostrarlo en el login.
      const msg = error.response?.data?.message || 'El acceso al sistema está bloqueado en este momento.';
      localStorage.setItem('accessBlockMsg', msg);
      localStorage.removeItem('token');
      if (!window.location.pathname.startsWith('/login')) window.location.href = '/login';
    } else if (status === 401) {
      localStorage.removeItem('token');
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
