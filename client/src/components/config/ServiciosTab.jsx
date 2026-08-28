import { useEffect, useMemo, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { EmptyState } from '../PageHeader';
import { HiOutlineClock, HiOutlineMagnifyingGlass, HiOutlineTag } from 'react-icons/hi2';

/**
 * CUÁNTO DURA CADA SERVICIO de la agenda.
 *
 * No todos ocupan lo mismo: un control son diez minutos y un tratamiento puede
 * llevar una hora. Antes la disponibilidad se miraba minuto a minuto, así que
 * una cita de 40 minutos empezada a las 14:00 desaparecía del panel en cuanto se
 * consultaba las 14:20: el hueco parecía libre y se agendaba encima del
 * paciente que todavía estaba dentro.
 *
 * Son los servicios de la AGENDA (los que salen al agendar una cita), no los del
 * inventario. Ver el modelo AppointmentServiceItem para el porqué de que sean
 * dos catálogos distintos.
 *
 * «Lo que dure la cita normal» es el valor por defecto y sigue siendo lo
 * correcto para la mayoría: solo hace falta configurar los que se salen de la
 * norma, que son unos pocos.
 */

// Duraciones habituales. No es un campo libre para que la agenda no acabe con
// servicios de 37 minutos que no cuadran con ninguna rejilla.
const DURACIONES = [
  { value: 0, label: 'Lo que dure la cita normal' },
  { value: 10, label: '10 minutos' },
  { value: 15, label: '15 minutos' },
  { value: 20, label: '20 minutos' },
  { value: 30, label: '30 minutos' },
  { value: 45, label: '45 minutos' },
  { value: 60, label: '1 hora' },
  { value: 90, label: '1 h 30 min' },
  { value: 120, label: '2 horas' },
  { value: 180, label: '3 horas' },
];

export default function ServiciosTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [guardando, setGuardando] = useState(null);
  const [busca, setBusca] = useState('');

  useEffect(() => {
    let vivo = true;
    api
      .get('/appointment-service-items')
      .then((r) => { if (vivo) setItems(Array.isArray(r.data) ? r.data : []); })
      .catch((err) => toast.error(err.response?.data?.message || 'No se pudo cargar el catálogo'))
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, []);

  const guardar = async (item, minutos) => {
    setGuardando(item._id);
    // Optimista: el select ya muestra lo elegido y se revierte si falla. Con una
    // lista larga, esperar a la respuesta en cada cambio se siente roto.
    const antes = item.durationMinutes || 0;
    setItems((l) => l.map((i) => (i._id === item._id ? { ...i, durationMinutes: minutos } : i)));
    try {
      await api.put(`/appointment-service-items/${item._id}`, { durationMinutes: minutos });
      toast.success(
        minutos > 0
          ? `${item.name}: ${DURACIONES.find((d) => d.value === minutos)?.label || `${minutos} min`}`
          : `${item.name}: lo que dure la cita normal`,
      );
    } catch (err) {
      setItems((l) => l.map((i) => (i._id === item._id ? { ...i, durationMinutes: antes } : i)));
      toast.error(err.response?.data?.message || 'No se pudo guardar');
    } finally {
      setGuardando(null);
    }
  };

  const visibles = useMemo(() => {
    const q = busca.trim().toLowerCase();
    const lista = q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
    // Los que YA tienen una duración propia van arriba: son los que el
    // administrador viene a revisar.
    return [...lista].sort((a, b) => {
      const da = a.durationMinutes || 0;
      const db = b.durationMinutes || 0;
      if (!!da !== !!db) return da ? -1 : 1;
      return a.name.localeCompare(b.name, 'es');
    });
  }, [items, busca]);

  const configurados = items.filter((i) => i.durationMinutes > 0).length;

  if (loading) return <p className="text-sm text-slate-400 py-8 text-center">Cargando servicios…</p>;

  if (items.length === 0) {
    return (
      <EmptyState
        icon={HiOutlineTag}
        title="Todavía no hay servicios de agenda"
        hint="Se crean solos al agendar: quien agenda escribe el servicio y queda disponible para los demás."
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="bg-sky-50 border border-sky-200 text-sky-900 text-xs sm:text-sm rounded-xl px-3 py-2">
        La duración es lo que el servicio <b>ocupa</b> en la agenda. Al agendar, «Disponibilidad en
        este horario» enseña las citas que siguen en curso aunque hayan empezado antes: una de una
        hora que empezó a las 14:00 aparece también al mirar las 14:30.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[12rem]">
          <HiOutlineMagnifyingGlass className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar un servicio…"
            className="input pl-9"
          />
        </div>
        <span className="text-xs text-slate-500 whitespace-nowrap">
          {configurados} de {items.length} con duración propia
        </span>
      </div>

      <ul className="m-0 p-0 list-none space-y-1.5">
        {visibles.map((item) => (
          <li
            key={item._id}
            className="flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-2"
          >
            <span
              className="w-2.5 h-2.5 rounded-full shrink-0"
              style={{ backgroundColor: item.color || '#0f766e' }}
            />
            <span className="flex-1 min-w-[8rem] text-sm text-slate-800 break-words">
              {item.name}
              {item.nursingService && (
                <span className="ml-1.5 text-[10px] rounded bg-sky-100 text-sky-800 px-1 py-px align-middle">
                  enfermería
                </span>
              )}
            </span>
            <span className="flex items-center gap-1.5 shrink-0">
              <HiOutlineClock
                className={`w-4 h-4 ${item.durationMinutes > 0 ? 'text-emerald-600' : 'text-slate-300'}`}
              />
              <select
                value={item.durationMinutes || 0}
                disabled={guardando === item._id}
                onChange={(e) => guardar(item, Number(e.target.value))}
                className="input input-sm w-52 cursor-pointer disabled:opacity-60"
              >
                {DURACIONES.map((d) => (
                  <option key={d.value} value={d.value}>{d.label}</option>
                ))}
              </select>
            </span>
          </li>
        ))}
        {visibles.length === 0 && (
          <li className="text-center text-sm text-slate-400 py-6">Nada coincide con «{busca}».</li>
        )}
      </ul>
    </div>
  );
}
