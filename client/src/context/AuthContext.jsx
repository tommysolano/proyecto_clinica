import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/axios';
import { roleSatisfies } from '../utils/roles';
import { activarPush, desactivarPush } from '../utils/push';

const AuthContext = createContext(null);

/**
 * LA SESIÓN SE PINTA DESDE LA ÚLTIMA COPIA, SIN ESPERAR AL SERVIDOR.
 *
 * Al abrir o recargar Vikingo, NADA se dibujaba hasta que respondía /auth/me: en
 * un equipo con internet débil eso era la pantalla en blanco con el spinner, y
 * todas las peticiones de la pantalla esperaban detrás. Ahora se arranca con la
 * última respuesta guardada (atada al MISMO token: otro token, otra sesión) y
 * /auth/me se confirma por detrás; si el rol o la sucursal cambiaron, se corrige
 * en cuanto responde. Los permisos los sigue decidiendo el servidor en cada
 * petición: la copia solo adelanta la pantalla.
 *
 * Y si /auth/me falla por RED (no por sesión inválida) habiendo copia, se sigue
 * trabajando: antes un corte de un segundo o un deploy en curso al recargar
 * cerraban la sesión del usuario.
 */
const ME_CACHE_KEY = 'authMeCache';
function readMeCache(token) {
  try {
    const c = JSON.parse(localStorage.getItem(ME_CACHE_KEY) || 'null');
    return c && c.token === token ? c.data : null;
  } catch {
    return null;
  }
}
function writeMeCache(data) {
  try {
    const token = localStorage.getItem('token');
    const raw = JSON.stringify({ token, data });
    // Un logo en base64 enorme no debe llenar el almacenamiento del navegador.
    if (token && raw.length < 400000) localStorage.setItem(ME_CACHE_KEY, raw);
  } catch {
    /* sin almacenamiento disponible: simplemente no hay copia */
  }
}
function clearMeCache() {
  try {
    localStorage.removeItem(ME_CACHE_KEY);
  } catch {
    /* noop */
  }
}

/**
 * Flujo de auth:
 *   1) login(email, password) → recibe token preliminar + lista de clínicas.
 *   2) selectClinic(clinicId) → recibe nuevo token con clinicId+role.
 *   3) /auth/me → datos completos (user, activeClinic, role, clinics).
 *
 * Si el usuario tiene una sola clínica se selecciona automáticamente.
 */
export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [activeClinic, setActiveClinic] = useState(null);
  const [role, setRole] = useState(null);
  const [clinics, setClinics] = useState([]);
  const [loading, setLoading] = useState(true);

  const applyMe = useCallback((data) => {
    setUser(data.user);
    setActiveClinic(data.activeClinic || null);
    setRole(data.role || null);
    setClinics(data.clinics || []);
  }, []);

  const refreshMe = useCallback(async () => {
    const res = await api.get('/auth/me');
    applyMe(res.data);
    writeMeCache(res.data);
    return res.data;
  }, [applyMe]);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      setLoading(false);
      return;
    }
    const cached = readMeCache(token);
    if (cached) {
      applyMe(cached);
      setLoading(false);
    }
    refreshMe()
      .catch((err) => {
        const status = err?.response?.status;
        // Sin red o servidor reiniciándose: con copia, se sigue trabajando.
        if (cached && status !== 401 && status !== 403) return;
        localStorage.removeItem('token');
        clearMeCache();
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [refreshMe, applyMe]);

  const login = async (email, password) => {
    const res = await api.post('/auth/login', { email, password });
    localStorage.setItem('token', res.data.token);
    setUser(res.data.user);
    setClinics(res.data.clinics || []);
    setActiveClinic(null);
    setRole(null);
    // Auto-seleccionar si hay solo una clínica
    if ((res.data.clinics || []).length === 1) {
      await selectClinic(res.data.clinics[0]._id || res.data.clinics[0].clinic);
    }
    return res.data;
  };

  const selectClinic = async (clinicId) => {
    const res = await api.post('/auth/select-clinic', { clinicId });
    localStorage.setItem('token', res.data.token);
    await refreshMe();
    return res.data;
  };

  /**
   * Notificaciones push del aparato. Se engancha cuando ya hay sucursal activa
   * porque la suscripción se guarda con ella (y porque hasta ese momento las
   * peticiones a /push darían 403 por falta de clínica).
   */
  useEffect(() => {
    if (!user || !activeClinic) return;
    // Sin pedir permiso: si ya está concedido, esto reengancha el aparato en
    // silencio. Pedirlo aquí, nada más entrar, era lo que hacía que la gente lo
    // descartara sin leerlo; ahora se pide desde la campana, con un clic.
    activarPush({ pedirPermiso: false });
  }, [user, activeClinic]);

  const logout = () => {
    // Antes de soltar el token: la baja del aparato es una llamada autenticada.
    // Si no se da de baja, quien use después ese ordenador recibiría los avisos
    // del anterior.
    desactivarPush().finally(() => {
      localStorage.removeItem('token');
      clearMeCache();
      setUser(null);
      setActiveClinic(null);
      setRole(null);
      setClinics([]);
    });
  };

  const hasRole = (...roles) => roleSatisfies(role, roles);

  return (
    <AuthContext.Provider
      value={{
        user,
        activeClinic,
        role,
        clinics,
        loading,
        login,
        selectClinic,
        logout,
        hasRole,
        refreshMe,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
