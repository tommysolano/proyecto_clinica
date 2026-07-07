import { createContext, useContext, useState, useEffect, useCallback } from 'react';
import api from '../api/axios';
import { roleSatisfies } from '../utils/roles';

const AuthContext = createContext(null);

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

  const refreshMe = useCallback(async () => {
    const res = await api.get('/auth/me');
    setUser(res.data.user);
    setActiveClinic(res.data.activeClinic || null);
    setRole(res.data.role || null);
    setClinics(res.data.clinics || []);
    return res.data;
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      setLoading(false);
      return;
    }
    refreshMe()
      .catch(() => {
        localStorage.removeItem('token');
        setUser(null);
      })
      .finally(() => setLoading(false));
  }, [refreshMe]);

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

  const logout = () => {
    localStorage.removeItem('token');
    setUser(null);
    setActiveClinic(null);
    setRole(null);
    setClinics([]);
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
