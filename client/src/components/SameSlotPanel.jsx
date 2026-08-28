import { useEffect, useState } from 'react';
import api from '../api/axios';

/**
 * Panel reutilizable que muestra las citas existentes en una fecha + hora dadas,
 * para que quien agenda vea qué tan saturado está ese momento.
 *
 * Lo usa la página de Citas (modo panel lateral) y el call center desde el chat
 * (modo `compact`). Los dos enseñan LO MISMO: quien agenda desde el chat toma la
 * misma decisión que quien agenda desde recepción y necesita los mismos datos.
 *
 * Props:
 *  - date: 'YYYY-MM-DD'
 *  - startTime: 'HH:MM'
 *  - excludeId?: id de cita a excluir (cuando se edita)
 *  - clinicId?: limita la consulta a esa clínica (útil cuando el usuario tiene varias)
 *  - compact?: estilo compacto (sin border-l ni sticky), pensado para modales angostos
 */

/** Nombre del servicio de una cita. */
const nombreServicio = (a) =>
  // `serviceName` es el SNAPSHOT y es lo que hay que leer: el servicio sale del
  // catálogo de agenda (AppointmentServiceItem), no del inventario. `services[]`
  // es el array legado —lo llenaba el selector de servicios que se retiró—, así
  // que las citas nuevas lo tienen vacío: mirar solo ahí era la razón de que el
  // panel no enseñara ningún servicio.
  a?.serviceName ||
  a?.serviceItem?.name ||
  (Array.isArray(a?.services) ? a.services.map((s) => s.name || s.product?.name).filter(Boolean).join(', ') : '') ||
  '';

/** Sucursal de la cita. */
const nombreSucursal = (a) => a?.clinic?.nombreComercial || a?.clinic?.name || '';

/** Quién la atiende: el doctor en turno, o enfermería si es un turno suyo. */
const nombreProfesional = (a) => a?.doctor?.name || a?.attendedByNurse?.name || '';

/**
 * Una cita del listado. Los dos modos pintan lo mismo, solo cambian los
 * tamaños: tenerlo duplicado ya provocó que el servicio se arreglara en un
 * modo y no en el otro.
 *
 * El SERVICIO y la SUCURSAL van arriba y siempre: son lo que decide si ese
 * hueco sirve. Dos citas a las 08:00 no son un problema si son en sedes
 * distintas, y sí lo son si las dos necesitan al mismo enfermero.
 */
function Fila({ a, small }) {
  const servicio = nombreServicio(a);
  const sucursal = nombreSucursal(a);
  const profesional = nombreProfesional(a);
  const t = small
    ? { wrap: 'px-2 py-1.5 text-[11px]', sub: 'text-[10px]', chip: 'text-[9px] px-1 py-px' }
    : { wrap: 'px-3.5 py-2.5 text-xs', sub: 'text-[11px]', chip: 'text-[10px] px-1.5 py-0.5' };
  return (
    <li className={`bg-white border border-slate-200 rounded-lg ${t.wrap}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-800 truncate">
          {a.patient?.firstName} {a.patient?.lastName}
        </span>
        <span className={`${t.sub} text-slate-500 flex-shrink-0`}>{a.startTime}</span>
      </div>

      <div className="mt-1 flex flex-wrap items-center gap-1">
        {servicio ? (
          <span className={`${t.chip} rounded bg-emerald-100 text-emerald-800 font-medium max-w-full truncate`}>
            {servicio}
          </span>
        ) : (
          <span className={`${t.chip} rounded bg-slate-100 text-slate-400 italic`}>Sin servicio</span>
        )}
        {sucursal && (
          <span className={`${t.chip} rounded bg-sky-100 text-sky-800 font-medium max-w-full truncate`}>
            {sucursal}
          </span>
        )}
      </div>

      {profesional && (
        <div className={`${t.sub} text-emerald-700 mt-0.5 truncate`}>{profesional}</div>
      )}
      {a.room?.name && <div className={`${t.sub} text-slate-400 truncate`}>{a.room.name}</div>}
    </li>
  );
}

function Vacio({ small }) {
  return (
  <div className={`text-center ${small ? 'py-3' : 'py-6'}`}>
    <p className={`${small ? 'text-[11px]' : 'text-xs'} text-emerald-700 font-semibold`}>✓ Horario libre</p>
    <p className={`${small ? 'text-[10px]' : 'text-[11px]'} text-slate-400`}>No hay otras citas a esta hora.</p>
  </div>
  );
}


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
        <div className="rounded-md border border-slate-200 bg-white p-2 min-h-[80px] max-h-[220px] overflow-y-auto">
          {!date || !startTime ? (
            <p className="text-[11px] text-slate-400 text-center py-3">
              Selecciona fecha y hora para ver la disponibilidad
            </p>
          ) : loading ? (
            <p className="text-[11px] text-slate-400 text-center py-3">Cargando...</p>
          ) : list.length === 0 ? (
            <Vacio small />
          ) : (
            <>
              <p className="text-[10px] text-amber-700 font-semibold uppercase mb-1">
                {list.length} cita{list.length === 1 ? '' : 's'} ya agendada
                {list.length === 1 ? '' : 's'} en este horario
              </p>
              <ul className="space-y-1">
                {list.map((a) => (
                  <Fila key={a._id} a={a} small />
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
            <Vacio />
          ) : (
            <>
              <p className="text-[11px] text-amber-700 font-semibold uppercase mb-2">
                {list.length} cita{list.length === 1 ? '' : 's'} agendada
                {list.length === 1 ? '' : 's'}
              </p>
              <ul className="space-y-2">
                {list.map((a) => (
                  <Fila key={a._id} a={a} />
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </aside>
  );
}
