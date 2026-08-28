import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { EmptyState } from '../PageHeader';
import { HiOutlineBuildingOffice2, HiOutlineClock } from 'react-icons/hi2';
import { nombreSucursal } from '../../utils/clinicName';
import { slotTimesOfDay } from '../../utils/slots';

/**
 * ESPACIOS DE LA AGENDA, por sucursal.
 *
 * Con 20 minutos, una cita solo puede empezar a las 14:00, 14:20, 14:40… El
 * campo de hora deja de ser libre y pasa a ser una lista. Antes se podía agendar
 * a las 18:37 y una agenda a horas sueltas no se lee de un vistazo ni se reparte
 * entre profesionales: cada cita empieza donde acabó la anterior.
 *
 * «Cualquier hora» sigue existiendo y es el valor por defecto: encender la
 * rejilla cambia cómo agenda todo el mundo, así que lo decide el administrador.
 */

// Los intervalos que se usan de verdad. No es un campo libre a propósito: un
// intervalo de 7 minutos genera una rejilla que no cuadra con la hora en punto.
const INTERVALOS = [
  { value: 0, label: 'Cualquier hora (sin espacios)' },
  { value: 10, label: 'Cada 10 minutos' },
  { value: 15, label: 'Cada 15 minutos' },
  { value: 20, label: 'Cada 20 minutos' },
  { value: 30, label: 'Cada 30 minutos' },
  { value: 45, label: 'Cada 45 minutos' },
  { value: 60, label: 'Cada hora' },
];

export default function AgendaTab({ clinics, onClinicsChange }) {
  const [guardando, setGuardando] = useState(null);

  const guardar = async (clinic, minutos) => {
    setGuardando(clinic._id);
    try {
      await api.put(`/clinics/${clinic._id}`, { appointmentSlotMinutes: minutos });
      onClinicsChange((list) =>
        list.map((c) => (c._id === clinic._id ? { ...c, appointmentSlotMinutes: minutos } : c)),
      );
      toast.success(
        minutos > 0
          ? `${nombreSucursal(clinic)}: citas cada ${minutos} minutos`
          : `${nombreSucursal(clinic)}: cualquier hora`,
      );
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo guardar');
    } finally {
      setGuardando(null);
    }
  };

  if (clinics.length === 0) {
    return (
      <EmptyState
        icon={HiOutlineBuildingOffice2}
        title="No administras ninguna sucursal"
        hint="Solo puedes configurar la agenda de las sedes donde eres administrador."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-sky-50 border border-sky-200 text-sky-900 text-xs sm:text-sm rounded-xl px-3 py-2">
        Al activar los espacios, quien agenda deja de escribir la hora y la elige de una lista.
        Las citas <b>ya agendadas</b> a horas sueltas se conservan tal cual: esto solo afecta a las
        nuevas.
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {clinics.map((c) => {
          const minutos = Number(c.appointmentSlotMinutes) || 0;
          // Un ejemplo vale más que el número: se enseña cómo queda la tarde.
          const ejemplo = slotTimesOfDay(minutos)
            .filter((t) => t >= '14:00')
            .slice(0, 4);
          return (
            <div
              key={c._id}
              className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3"
            >
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-xl bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                  <HiOutlineClock className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <p className="font-semibold text-slate-800 truncate m-0">{nombreSucursal(c)}</p>
                  <p className="text-xs text-slate-400 m-0">
                    {minutos > 0 ? `Citas cada ${minutos} minutos` : 'Sin espacios: cualquier hora'}
                  </p>
                </div>
              </div>

              <label className="block">
                <span className="block text-xs font-medium text-slate-500 mb-1">
                  Espacios entre citas
                </span>
                <select
                  value={minutos}
                  disabled={guardando === c._id}
                  onChange={(e) => guardar(c, Number(e.target.value))}
                  className="input"
                >
                  {INTERVALOS.map((i) => (
                    <option key={i.value} value={i.value}>{i.label}</option>
                  ))}
                </select>
              </label>

              <div className="text-xs text-slate-500 min-h-[2.5rem]">
                {minutos > 0 ? (
                  <>
                    Se podrá agendar a las{' '}
                    <b className="text-slate-700">{ejemplo.join(' · ')}</b>… y así toda la jornada.
                  </>
                ) : (
                  'Se puede agendar a cualquier hora, incluso a las 18:37.'
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
