import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

/**
 * Restringe una ruta a roles específicos. Si el usuario no tiene el rol,
 * lo redirige a la home (Dashboard u otra página por defecto).
 */
export default function RoleRoute({ roles, children }) {
  const { role, user } = useAuth();
  // El super-admin puede entrar a cualquier vista de cualquier clínica
  if (user?.isSuperAdmin) return children;
  // Regla: cualquier vista permitida a 'call_center' también la ve 'supervisor_call_center'.
  const expanded = roles.includes('call_center')
    ? Array.from(new Set([...roles, 'supervisor_call_center']))
    : roles;
  if (!role || !expanded.includes(role)) {
    return <Navigate to="/" replace />;
  }
  return children;
}