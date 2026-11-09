import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { roleSatisfies, isRestrictedAssistantPage } from '../utils/roles';

/**
 * Restringe una ruta a roles específicos. Si el usuario no tiene el rol,
 * lo redirige a la home (Dashboard u otra página por defecto).
 */
export default function RoleRoute({ roles, children }) {
  const { role, user } = useAuth();
  const { pathname } = useLocation();
  // El super-admin puede entrar a cualquier vista de cualquier clínica
  if (user?.isSuperAdmin) return children;
  if (isRestrictedAssistantPage(role, pathname) || !roleSatisfies(role, roles)) {
    return <Navigate to="/" replace />;
  }
  return children;
}
