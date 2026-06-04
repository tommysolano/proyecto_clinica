import { useEffect, useState } from 'react';
import api from '../api/axios';

/**
 * Panel reutilizable que muestra las citas existentes en una fecha + hora dadas,
 * para que el agendador vea qué tan saturado está ese momento.
 *
 * Props:
 *  - date: 'YYYY-MM-DD'
 *  - startTime: 'HH:MM'
 *  - excludeId?: id de cita a excluir (cuando se edita)
 *  - clinicId?: limita la consulta a esa clínica (útil cuando el usuario tiene varias)
 *  - compact?: estilo compacto (sin border-l ni sticky), pensado para modales angostos
 */
export default function SameSlotPanel({ date, startTime, excludeId, clinicId, compact = false }) {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!date || !startTime) {
      setList([]);
      return undefined;
    }
    let cancel = false;
    setLoading(true);
    const params = { startDate: date, endDate: date, fromTime: startTime, toTime: startTime };
    if (clinicId) params.clinic = clinicId;
    api
      .get('/appointments', { params })
      .then((r) => {
        if (cancel) return;
        const items = (r.data || []).filter((a) => String(a._id) !== String(excludeId || ''));
        setList(items);
      })
      .catch(() => {
        if (!cancel) setList([]);
      })
      .finally(() => {
        if (!cancel) setLoading(false);
      });
    return () => {
      cancel = true;
    };
  }, [date, startTime, excludeId, clinicId]);

  const fmtDateTitle = (d) => {
    if (!d) return '';
    const parts = String(d).split('-');
    if (parts.length < 3) return d;
    const [y, mo, da] = parts;
    return `${da}/${mo}/${y}`;
  };

  if (compact) {
    return (
      <div className="border border-emerald-200 rounded-lg bg-emerald-50/40 p-2 mt-2">
        <div className="flex items-center justify-between gap-2 mb-1">
          <h4 className="text-xs font-bold text-emerald-700 uppercase tracking-wide">
            Disponibilidad en este horario
          </h4>
          <span className="text-[10px] text-slate-500">
            {date && startTime ? `${fmtDateTitle(date)} · ${startTime}` : '—'}
          </span>
        </div>
        <div className="rounded-md border border-slate-200 bg-white p-2 min-h-[80px] max-h-[180px] overflow-y-auto">
          {!date || !startTime ? (
            <p className="text-[11px] text-slate-400 text-center py-3">
              Selecciona fecha y hora para ver la disponibilidad
            </p>
          ) : loading ? (
            <p className="text-[11px] text-slate-400 text-center py-3">Cargando...</p>
          ) : list.length === 0 ? (
            <div className="text-center py-3">
              <p className="text-[11px] text-emerald-700 font-semibold">✓ Horario libre</p>
              <p className="text-[10px] text-slate-400">No hay otras citas a esta hora.</p>
            </div>
          ) : (
            <>
              <p className="text-[10px] text-amber-700 font-semibold uppercase mb-1">
                {list.length} cita{list.length === 1 ? '' : 's'} ya agendada
                {list.length === 1 ? '' : 's'} en este horario
              </p>
              <ul className="space-y-1">
                {list.map((a) => (
                  <li
                    key={a._id}
                    className="bg-slate-50 border border-slate-200 rounded px-2 py-1 text-[11px]"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-800 truncate">
                        {a.patient?.firstName} {a.patient?.lastName}
                      </span>
                      <span className="text-[10px] text-slate-500 flex-shrink-0">{a.startTime}</span>
                    </div>
                    {a.doctor?.name && (
                      <div className="text-[10px] text-emerald-700">Dr. {a.doctor.name}</div>
                    )}
                    {Array.isArray(a.services) && a.services.length > 0 && (
                      <div className="text-[10px] text-slate-500 truncate">
                        {a.services.map((s) => s.name).filter(Boolean).join(', ')}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    );
  }

  // Modo "panel lateral" (uso original en Appointments.jsx).
  return (
    <aside className="border-l border-slate-200 lg:pl-5">
      <div className="sticky top-0 space-y-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-800">Disponibilidad en este horario</h3>
          <p className="text-xs text-slate-500">
            {date && startTime ? (
              <>
                Para <b>{fmtDateTitle(date)}</b> a las <b>{startTime}</b>
              </>
            ) : (
              'Selecciona fecha y hora para ver la disponibilidad'
            )}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-3 overflow-y-auto min-h-[200px] max-h-[420px]">
          {!date || !startTime ? (
            <p className="text-xs text-slate-400 text-center py-6">Sin fecha/hora seleccionada</p>
          ) : loading ? (
            <p className="text-xs text-slate-400 text-center py-6">Cargando...</p>
          ) : list.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-xs text-emerald-700 font-medium">✓ Horario libre</p>
              <p className="text-[11px] text-slate-400 mt-1">No hay otras citas a esta hora.</p>
            </div>
          ) : (
            <>
              <p className="text-[11px] text-amber-700 font-semibold uppercase mb-2">
                {list.length} cita{list.length === 1 ? '' : 's'} agendada
                {list.length === 1 ? '' : 's'}
              </p>
              <ul className="space-y-2">
                {list.map((a) => (
                  <li
                    key={a._id}
                    className="bg-white border border-slate-200 rounded-xl px-3.5 py-2.5 text-xs"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium text-slate-800 truncate">
                        {a.patient?.firstName} {a.patient?.lastName}
                      </span>
                      <span className="text-[10px] text-slate-500 flex-shrink-0">{a.startTime}</span>
                    </div>
                    {a.doctor?.name && (
                      <div className="text-[11px] text-emerald-700 mt-0.5">Dr. {a.doctor.name}</div>
                    )}
                    {Array.isArray(a.services) && a.services.length > 0 && (
                      <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                        {a.services.map((s) => s.name).filter(Boolean).join(', ')}
                      </div>
                    )}
                    {a.room?.name && (
                      <div className="text-[11px] text-slate-400 mt-0.5">{a.room.name}</div>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
