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

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;
    const code = error.response?.data?.code;
    if (status === 401) {
      localStorage.removeItem('token');
      window.location.href = '/login';
    } else if (status === 403 && code === 'CLINIC_REQUIRED') {
      // Token válido pero sin clínica seleccionada → forzar selección
      window.location.href = '/select-clinic';
    }
    return Promise.reject(error);
  }
);

export default api;
