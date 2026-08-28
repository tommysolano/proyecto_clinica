import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import PageHeader from '../components/PageHeader';
import StaffClinicsTab from '../components/config/StaffClinicsTab';
import AgendaTab from '../components/config/AgendaTab';
import ServiciosTab from '../components/config/ServiciosTab';
import {
  HiOutlineCog6Tooth,
  HiOutlineUsers,
  HiOutlineCalendarDays,
  HiOutlineTag,
  HiOutlineArrowPath,
} from 'react-icons/hi2';

/**
 * CONFIGURACIÓN DE LA CLÍNICA (administradores).
 *
 * Reúne los ajustes que reparten el trabajo entre sedes y que hasta ahora no
 * tenían dónde vivir:
 *  - Personal por sucursal: en qué sede está cada médico, cajero y enfermero.
 *    De ahí salen los avisos de citas.
 *  - Agenda: en qué espacios de tiempo se puede agendar en cada sede.
 *  - Duración de servicios: cuánto OCUPA cada servicio, para que la
 *    disponibilidad al agendar cuente las citas que siguen en curso.
 *
 * Las dos pestañas trabajan sobre las MISMAS sucursales —las que este
 * administrador gestiona— así que se piden una sola vez aquí y se comparten.
 */

const TABS = [
  { id: 'personal', label: 'Personal por sucursal', icon: HiOutlineUsers },
  { id: 'agenda', label: 'Agenda', icon: HiOutlineCalendarDays },
  { id: 'servicios', label: 'Duración de servicios', icon: HiOutlineTag },
];

export default function AdminConfig() {
  const [params, setParams] = useSearchParams();
  const tab = TABS.some((t) => t.id === params.get('tab')) ? params.get('tab') : 'personal';

  const [clinics, setClinics] = useState([]);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);

  const cargar = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/users/assignments');
      setClinics(data.clinics || []);
      setUsers(data.users || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar la configuración');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    cargar();
  }, []);

  const irA = (id) => setParams(id === 'personal' ? {} : { tab: id }, { replace: true });

  return (
    <div className="space-y-6">
      <PageHeader
        icon={HiOutlineCog6Tooth}
        title="Configuración de la clínica"
        subtitle="Quién trabaja en cada sucursal y cómo se reparte la agenda."
      >
        <button onClick={cargar} className="btn-secondary" disabled={loading}>
          <HiOutlineArrowPath className="w-4 h-4" /> Recargar
        </button>
      </PageHeader>

      <div className="flex gap-1 border-b border-slate-200 overflow-x-auto">
        {TABS.map((t) => {
          const activa = t.id === tab;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => irA(t.id)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium whitespace-nowrap border-none bg-transparent cursor-pointer border-b-2 -mb-px ${
                activa
                  ? 'text-emerald-700 border-b-emerald-600'
                  : 'text-slate-500 hover:text-slate-700 border-b-transparent'
              }`}
            >
              <t.icon className="w-4 h-4" />
              {t.label}
            </button>
          );
        })}
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600"></div>
        </div>
      ) : tab === 'servicios' ? (
        <ServiciosTab />
      ) : tab === 'agenda' ? (
        <AgendaTab clinics={clinics} onClinicsChange={setClinics} />
      ) : (
        <StaffClinicsTab clinics={clinics} users={users} onUsersChange={setUsers} />
      )}
    </div>
  );
}
