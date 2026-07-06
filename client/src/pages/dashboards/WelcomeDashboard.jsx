import { useAuth } from '../../context/AuthContext';

const ROLE_LABELS = {
  admin: 'Administrador',
  cajero: 'Cajero',
  doctor: 'Doctor',
  optica: 'Óptica',
  call_center: 'Call Center',
  marketing: 'Marketing',
  enfermero: 'Enfermería',
  contabilidad: 'Contabilidad',
};

/**
 * Dashboard de bienvenida (placeholder por rol). Cada rol tiene su propio
 * componente (DashboardAdmin, DashboardDoctor, ...) que por ahora renderiza
 * esta pantalla; el contenido específico de cada rol se irá agregando luego.
 */
export default function WelcomeDashboard({ roleLabel }) {
  const { user, role } = useAuth();
  const label = roleLabel || ROLE_LABELS[role] || '';
  const firstName = (user?.name || '').trim().split(/\s+/)[0] || '';

  return (
    <div className="flex flex-col items-center justify-center text-center py-24">
      <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-white text-2xl font-bold shadow-lg mb-5">
        {(user?.name || '?').trim().charAt(0).toUpperCase()}
      </div>
      <h1 className="text-3xl font-bold text-slate-800">
        Bienvenido{firstName ? `, ${firstName}` : ''}
      </h1>
      {label && (
        <p className="text-slate-400 mt-2 text-sm uppercase tracking-wider font-semibold">
          {label}
        </p>
      )}
    </div>
  );
}
