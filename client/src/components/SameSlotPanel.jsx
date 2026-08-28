import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';

/**
 * Panel reutilizable que muestra las citas que OCUPAN una fecha + hora dadas,
 * para que quien agenda vea qué tan saturado está ese momento.
 *
 * Lo usa la página de Citas (modo panel lateral) y el call center desde el chat
 * (modo `compact`). Los dos enseñan LO MISMO: quien agenda desde el chat toma la
 * misma decisión que quien agenda desde recepción y necesita los mismos datos.
 *
 * NO ES UNA COINCIDENCIA EXACTA DE HORA, es un SOLAPAMIENTO. Antes se pedían al
 * servidor las citas cuyo `startTime` fuera exactamente el consultado, y eso
 * escondía justo las que importan: una cita de 40 minutos empezada a las 14:00
 * desaparecía del panel al mirar las 14:20 —el hueco parecía libre y se agendaba
 * encima del paciente que seguía dentro—. Ahora se trae el día entero (una sola
 * petición por fecha, en vez de una por cada tecla en la hora) y se calcula aquí
 * qué sigue en curso, con la duración de cada servicio.
 *
 * Props:
 *  - date: 'YYYY-MM-DD'
 *  - startTime: 'HH:MM'
 *  - excludeId?: id de cita a excluir (cuando se edita)
 *  - clinicId?: limita la consulta a esa clínica (útil cuando el usuario tiene varias)
 *  - serviceItemId?: el servicio que se está agendando. Si dura 40 min, también
 *    chocan las citas que empiezan DENTRO de esos 40 minutos.
 *  - compact?: estilo compacto (sin border-l ni sticky), pensado para modales angostos
 */

const aMinutos = (hhmm) => {
  const [h, m] = String(hhmm || '').split(':').map(Number);
  if (!Number.isFinite(h)) return null;
  return h * 60 + (Number.isFinite(m) ? m : 0);
};

const aHHMM = (min) =>
  `${String(Math.floor(min / 60) % 24).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

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
 * Cuánto OCUPA una cita, en minutos. 0 = solo su minuto de inicio, que es como
 * se comportaba todo antes de que los servicios tuvieran duración: sin nada
 * configurado, el panel enseña exactamente lo de siempre.
 */
const duracionDe = (a, duracionPorServicio) => {
  // Una hora de fin explícita manda sobre el catálogo: es lo que se pactó con el
  // paciente al agendar, aunque después se cambie la duración del servicio.
  const ini = aMinutos(a?.startTime);
  const fin = aMinutos(a?.endTime);
  if (ini !== null && fin !== null && fin > ini) return fin - ini;
  const id = String(a?.serviceItem?._id || a?.serviceItem || '');
  return duracionPorServicio.get(id) || 0;
};

/**
 * ¿Se pisan [iniA, iniA+durA) y [iniB, iniB+durB)?
 *
 * Las duraciones de 0 cuentan como un minuto para que el caso «nada
 * configurado» siga siendo la coincidencia exacta de hora de siempre, en vez de
 * dejar de casar nunca por tener longitud cero.
 */
const seSolapan = (iniA, durA, iniB, durB) => {
  const finA = iniA + Math.max(durA, 1);
  const finB = iniB + Math.max(durB, 1);
  return iniA < finB && finA > iniB;
};

function Fila({ a, small, minutoConsultado, duracion }) {
  const servicio = nombreServicio(a);
  const sucursal = nombreSucursal(a);
  const profesional = nombreProfesional(a);
  const ini = aMinutos(a.startTime);
  // Empezó antes de la hora que se está mirando y todavía no ha terminado: es la
  // que el panel escondía y por la que se agendaba encima.
  const vieneDeAntes = ini !== null && minutoConsultado !== null && ini < minutoConsultado;
  const t = small
    ? { wrap: 'px-2 py-1.5 text-[11px]', sub: 'text-[10px]', chip: 'text-[9px] px-1 py-px' }
    : { wrap: 'px-3.5 py-2.5 text-xs', sub: 'text-[11px]', chip: 'text-[10px] px-1.5 py-0.5' };
  return (
    <li className={`bg-white border rounded-lg ${vieneDeAntes ? 'border-amber-300' : 'border-slate-200'} ${t.wrap}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-slate-800 truncate">
          {a.patient?.firstName} {a.patient?.lastName}
        </span>
        <span className={`${t.sub} text-slate-500 flex-shrink-0 whitespace-nowrap`}>
          {a.startTime}
          {duracion > 0 && ini !== null && ` – ${aHHMM(ini + duracion)}`}
        </span>
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
        {vieneDeAntes && (
          <span className={`${t.chip} rounded bg-amber-100 text-amber-800 font-medium whitespace-nowrap`}>
            sigue en curso
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

function Vacio({ small, filtrado }) {
  return (
    <div className={`text-center ${small ? 'py-3' : 'py-6'}`}>
      <p className={`${small ? 'text-[11px]' : 'text-xs'} text-emerald-700 font-semibold`}>
        {filtrado ? '✓ Nada de ese servicio' : '✓ Horario libre'}
      </p>
      <p className={`${small ? 'text-[10px]' : 'text-[11px]'} text-slate-400`}>
        {filtrado ? 'No hay citas de ese servicio a esta hora.' : 'No hay otras citas a esta hora.'}
      </p>
    </div>
  );
}

/** Selector de servicio para acotar la lista. */
function FiltroServicio({ value, onChange, servicios, small }) {
  if (servicios.length < 2) return null;
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`input input-sm cursor-pointer ${small ? 'text-[11px] py-0.5' : ''} w-full`}
    >
      <option value="">Todos los servicios</option>
      {servicios.map((s) => (
        <option key={s} value={s}>{s}</option>
      ))}
    </select>
  );
}

export default function SameSlotPanel({ date, startTime, excludeId, clinicId, serviceItemId, compact = false }) {
  // Lo cargado se guarda CON la clave a la que pertenece (fecha + sucursal). De
  // ahí se deriva todo: qué citas valen y si todavía se está cargando. Así no
  // hace falta vaciar ni encender un `loading` desde el efecto —cada setState
  // ahí encadena un render de más— y nunca se enseña un instante la lista del
  // día anterior como si fuera la de hoy.
  const [dia, setDia] = useState({ clave: null, items: [] });
  const [duracionPorServicio, setDuracionPorServicio] = useState(() => new Map());
  const [filtro, setFiltro] = useState('');

  // El catálogo, una vez: de aquí sale cuánto ocupa cada servicio. Con `all=1`
  // para que una cita agendada con un servicio dado de baja siga sabiendo lo que
  // dura, en vez de encogerse a un minuto.
  useEffect(() => {
    let vivo = true;
    api
      .get('/appointment-service-items', { params: { all: 1 } })
      .then((r) => {
        if (!vivo) return;
        const m = new Map();
        (r.data || []).forEach((s) => m.set(String(s._id), Number(s.durationMinutes) || 0));
        setDuracionPorServicio(m);
      })
      .catch(() => {});
    return () => { vivo = false; };
  }, []);

  /**
   * Las citas del DÍA, no las del minuto. Se pide una vez por fecha: antes se
   * pedía en cada cambio de hora —una petición por tecla— y aun así traía menos
   * información de la necesaria.
   */
  const clave = date ? `${date}|${clinicId || ''}` : null;

  useEffect(() => {
    if (!date) return undefined;
    let cancel = false;
    const params = { startDate: date, endDate: date };
    if (clinicId) params.clinic = clinicId;
    api
      .get('/appointments', { params })
      .then((r) => { if (!cancel) setDia({ clave, items: Array.isArray(r.data) ? r.data : [] }); })
      .catch(() => { if (!cancel) setDia({ clave, items: [] }); });
    return () => { cancel = true; };
  }, [date, clinicId, clave]);

  const cargado = !!clave && dia.clave === clave;
  const loading = !!clave && !cargado;
  const delDia = useMemo(() => (cargado ? dia.items : []), [cargado, dia.items]);

  const minutoConsultado = aMinutos(startTime);
  const duracionNueva = duracionPorServicio.get(String(serviceItemId || '')) || 0;

  // Las que de verdad ocupan este momento.
  const ocupan = useMemo(() => {
    if (minutoConsultado === null) return [];
    return delDia
      .filter((a) => String(a._id) !== String(excludeId || ''))
      // Una cancelada o una ausencia ya no ocupan nada: enseñarlas como
      // «horario ocupado» haría descartar huecos que están libres.
      .filter((a) => !['cancelada', 'no_asistio'].includes(a.status))
      .map((a) => ({ a, ini: aMinutos(a.startTime), dur: duracionDe(a, duracionPorServicio) }))
      .filter(({ ini, dur }) => ini !== null && seSolapan(ini, dur, minutoConsultado, duracionNueva))
      .sort((x, y) => x.ini - y.ini);
  }, [delDia, excludeId, minutoConsultado, duracionNueva, duracionPorServicio]);

  // Las opciones del filtro salen del DÍA, no de lo que ya está filtrado: si
  // salieran de la lista visible, elegir uno vaciaría el desplegable.
  const servicios = useMemo(
    () => [...new Set(delDia.map(nombreServicio).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es')),
    [delDia]
  );

  const lista = filtro ? ocupan.filter(({ a }) => nombreServicio(a) === filtro) : ocupan;

  const fmtDateTitle = (d) => {
    if (!d) return '';
    const parts = String(d).split('-');
    if (parts.length < 3) return d;
    const [y, mo, da] = parts;
    return `${da}/${mo}/${y}`;
  };

  const sinSeleccion = !date || !startTime;
  const cuerpo = (small) => {
    if (sinSeleccion) {
      return (
        <p className={`${small ? 'text-[11px]' : 'text-xs'} text-slate-400 text-center ${small ? 'py-3' : 'py-6'}`}>
          {small ? 'Selecciona fecha y hora para ver la disponibilidad' : 'Sin fecha/hora seleccionada'}
        </p>
      );
    }
    if (loading) {
      return (
        <p className={`${small ? 'text-[11px]' : 'text-xs'} text-slate-400 text-center ${small ? 'py-3' : 'py-6'}`}>
          Cargando...
        </p>
      );
    }
    if (lista.length === 0) return <Vacio small={small} filtrado={!!filtro && ocupan.length > 0} />;
    return (
      <>
        <p className={`${small ? 'text-[10px]' : 'text-[11px]'} text-amber-700 font-semibold uppercase mb-1`}>
          {lista.length} cita{lista.length === 1 ? '' : 's'} en este horario
        </p>
        <ul className={`m-0 p-0 list-none ${small ? 'space-y-1' : 'space-y-2'}`}>
          {lista.map(({ a, dur }) => (
            <Fila key={a._id} a={a} small={small} minutoConsultado={minutoConsultado} duracion={dur} />
          ))}
        </ul>
      </>
    );
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
        {!sinSeleccion && servicios.length > 1 && (
          <div className="mb-1">
            <FiltroServicio value={filtro} onChange={setFiltro} servicios={servicios} small />
          </div>
        )}
        <div className="rounded-md border border-slate-200 bg-white p-2 min-h-[80px] max-h-[220px] overflow-y-auto">
          {cuerpo(true)}
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
                {duracionNueva > 0 && <> · dura <b>{duracionNueva} min</b></>}
              </>
            ) : (
              'Selecciona fecha y hora para ver la disponibilidad'
            )}
          </p>
        </div>
        {!sinSeleccion && servicios.length > 1 && (
          <FiltroServicio value={filtro} onChange={setFiltro} servicios={servicios} />
        )}
        <div className="rounded-xl border border-slate-200 bg-slate-50/40 p-3 overflow-y-auto min-h-[200px] max-h-[420px]">
          {cuerpo(false)}
        </div>
      </div>
    </aside>
  );
}
