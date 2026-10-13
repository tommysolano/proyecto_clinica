import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineClock,
  HiOutlineArrowPath,
  HiOutlineInformationCircle,
  HiOutlineUserCircle,
  HiOutlineXMark,
} from 'react-icons/hi2';
import api from '../api/axios';
import DateInput from '../components/DateInput';
import SearchableSelect from '../components/SearchableSelect';
import { fmtDate, fmtTimeEc, todayEc } from '../utils/date';
import { useSocketEvent } from '../context/SocketContext';

/**
 * TIEMPOS DE LOS DOCTORES (Fénix). Rehecha en oct-2026 porque no se entendía:
 *
 *  · «sin tiempo» no decía nada → ahora «No se cronometró», con el porqué;
 *  · la hora de la cita y la de la atención salían juntas, sin rótulo, y
 *    parecían contradecirse → ahora son tres columnas con nombre: la hora
 *    AGENDADA, cuándo LLEGÓ (recepción lo recibió) y cuándo lo ATENDIÓ el
 *    doctor (de «Atender» a cerrar su parte), con el retraso calculado;
 *  · no se sabía en qué orden salían las atenciones → el orden se escoge y se
 *    dice en pantalla;
 *  · no se podía mirar un solo doctor → filtro por doctor (también pulsando su
 *    fila en el resumen).
 *
 * El cálculo es del servidor (`GET /reports/doctor-times`, utils/tiemposDoctores.js).
 * El «ahora» se mantiene vivo solo: socket + recarga cada minuto.
 */

const sumarDias = (ymd, n) => {
  const [y, m, d] = ymd.split('-').map(Number);
  const f = new Date(y, m - 1, d + n);
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
};

/** 23 → «23 min»; 75 → «1 h 15 min». */
const fmtMin = (m) => {
  if (m == null || Number.isNaN(Number(m))) return '—';
  const total = Math.round(Number(m));
  if (total < 60) return `${total} min`;
  const h = Math.floor(total / 60);
  const r = total % 60;
  return r ? `${h} h ${String(r).padStart(2, '0')} min` : `${h} h`;
};

/** Mismos umbrales que el cronómetro de la consulta en la ficha del paciente. */
const tonoMinutos = (m) =>
  m >= 19 ? 'bg-red-50 text-red-700 ring-red-200'
    : m >= 14 ? 'bg-amber-50 text-amber-700 ring-amber-200'
      : 'bg-emerald-50 text-emerald-700 ring-emerald-200';

/** La hora agendada como instante (Ecuador es UTC-5 todo el año). */
const instanteAgendado = (fecha, hora) => {
  const ymd = String(fecha || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd) || !/^\d{1,2}:\d{2}$/.test(hora || '')) return null;
  const [h, m] = hora.split(':');
  const t = Date.parse(`${ymd}T${h.padStart(2, '0')}:${m}:00-05:00`);
  return Number.isNaN(t) ? null : t;
};

const ORDENES = {
  recientes: { label: 'Hora de atención · más recientes primero', fn: (a, b) => clave(b) - clave(a) },
  antiguas: { label: 'Hora de atención · más antiguas primero', fn: (a, b) => clave(a) - clave(b) },
  largas: { label: 'Duración · más largas primero', fn: (a, b) => (b.minutos ?? -1) - (a.minutos ?? -1) },
  doctor: { label: 'Doctor (A-Z) y hora', fn: (a, b) => a.doctor.localeCompare(b.doctor, 'es') || clave(a) - clave(b) },
};
/** Para ordenar por hora: cuándo empezó; si no se cronometró, cuándo terminó. */
function clave(a) {
  return new Date(a.inicio || a.fin || a.fecha).getTime() || 0;
}

const PROXIMA = {
  esperando: { label: 'Esperando', tono: 'bg-amber-50 text-amber-800 ring-amber-200', ayuda: 'El paciente ya llegó y le toca a este doctor' },
  en_cola: { label: 'En cola', tono: 'bg-sky-50 text-sky-800 ring-sky-200', ayuda: 'Le llega cuando termine el profesional que va antes' },
  agendada: { label: 'Por llegar', tono: 'bg-slate-100 text-slate-700 ring-slate-200', ayuda: 'Cita de hoy; el paciente aún no llega' },
};

function Pill({ className = '', title, children }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset whitespace-nowrap ${className}`}
    >
      {children}
    </span>
  );
}

function Kpi({ label, value, sub }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 px-3 py-2.5 min-w-0">
      <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="m-0 mt-0.5 text-xl font-bold text-slate-800 tabular-nums">{value}</p>
      {sub && <p className="m-0 text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

function Seccion({ titulo, sub, derecha, children }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="m-0 text-base font-semibold text-slate-800">{titulo}</h2>
          {sub && <p className="m-0 text-xs text-slate-500">{sub}</p>}
        </div>
        {derecha}
      </div>
      {children}
    </section>
  );
}

/** Qué está haciendo cada doctor HOY. */
function Ahora({ doctores, ahoraMs }) {
  const activos = doctores.filter((d) => d.ahora?.estado === 'en_consulta' || d.proximas.length);
  if (!activos.length) {
    return (
      <p className="m-0 text-sm text-slate-500 bg-white rounded-xl border border-slate-200 p-4 text-center">
        Ningún doctor está atendiendo ni tiene pacientes pendientes hoy.
      </p>
    );
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
      {activos.map((d) => {
        const enConsulta = d.ahora?.estado === 'en_consulta';
        const minutos = enConsulta && d.ahora.desde
          ? Math.max(0, Math.round((ahoraMs - new Date(d.ahora.desde).getTime()) / 60000))
          : 0;
        const proximas = [...d.proximas].sort((a, b) => String(a.hora).localeCompare(String(b.hora)));
        return (
          <div key={d._id} className={`bg-white rounded-xl border p-3 space-y-2 min-w-0 ${enConsulta ? 'border-emerald-300' : 'border-slate-200'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="m-0 font-semibold text-slate-800 break-words">{d.name}</p>
                {d.specialty && <p className="m-0 text-[11px] text-slate-500">{d.specialty}</p>}
              </div>
              {enConsulta ? (
                <Pill className={tonoMinutos(minutos)} title="Desde que pulsó «Atender»">● En consulta · {fmtMin(minutos)}</Pill>
              ) : (
                <Pill className="bg-slate-50 text-slate-500 ring-slate-200">Libre</Pill>
              )}
            </div>
            {enConsulta && (
              <p className="m-0 text-xs text-slate-700">
                Con <b>{d.ahora.paciente || 'paciente'}</b> desde las {fmtTimeEc(d.ahora.desde)}
                {d.ahora.hora ? <span className="text-slate-500"> (cita de las {d.ahora.hora})</span> : null}
              </p>
            )}
            {proximas.length > 0 && (
              <ul className="m-0 p-0 list-none space-y-1 border-t border-slate-100 pt-2">
                {proximas.slice(0, 5).map((p) => {
                  const t = PROXIMA[p.tipo] || PROXIMA.agendada;
                  return (
                    <li key={`${p.appointmentId}-${p.tipo}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-700">
                      <span className="tabular-nums text-slate-500 w-10">{p.hora || '—'}</span>
                      <span className="font-medium break-words">{p.paciente || 'Paciente'}</span>
                      <Pill className={t.tono} title={t.ayuda}>{t.label}</Pill>
                      {p.tipo === 'en_cola' && p.antes?.nombre && <span className="text-sky-700">después de {p.antes.nombre}</span>}
                    </li>
                  );
                })}
                {proximas.length > 5 && <li className="text-[11px] text-slate-500">y {proximas.length - 5} más</li>}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Una fila por doctor: cuántas atenciones y cuánto tarda. Pulsarla filtra. */
function ResumenPorDoctor({ doctores, onElegir }) {
  const filas = doctores.filter((d) => d.resumen?.atenciones);
  if (!filas.length) return null;
  return (
    <div className="overflow-x-auto bg-white rounded-xl border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
            <th className="text-left px-3 py-2 font-semibold">Doctor</th>
            <th className="text-right px-3 py-2 font-semibold">Atenciones</th>
            <th className="text-right px-3 py-2 font-semibold">Promedio</th>
            <th className="text-right px-3 py-2 font-semibold">Más corta</th>
            <th className="text-right px-3 py-2 font-semibold">Más larga</th>
            <th className="text-right px-3 py-2 font-semibold" title="Cerró la atención sin pulsar «Atender»: no se pudo medir">No cronometradas</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((d) => {
            const r = d.resumen;
            return (
              <tr key={d._id} onClick={() => onElegir(d._id)} className="border-t border-slate-100 cursor-pointer hover:bg-emerald-50/50" title="Ver solo este doctor">
                <td className="px-3 py-2">
                  <span className="font-medium text-slate-800">{d.name}</span>
                  {d.specialty && <span className="block text-[11px] text-slate-500">{d.specialty}</span>}
                </td>
                <td className="px-3 py-2 text-right tabular-nums font-semibold">{r.atenciones}</td>
                <td className="px-3 py-2 text-right tabular-nums">{fmtMin(r.promedioMin)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtMin(r.minMin)}</td>
                <td className="px-3 py-2 text-right tabular-nums text-slate-600">{fmtMin(r.maxMin)}</td>
                <td className={`px-3 py-2 text-right tabular-nums ${r.sinCronometro ? 'text-amber-700 font-semibold' : 'text-slate-400'}`}>{r.sinCronometro || 0}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** La duración de una atención, o por qué no la hay. */
function Duracion({ a }) {
  if (a.valida) return <Pill className={tonoMinutos(a.minutos)}>{fmtMin(a.minutos)}</Pill>;
  if (a.motivo === 'sin_cronometro') {
    return (
      <Pill className="bg-amber-50 text-amber-800 ring-amber-200" title="El doctor cerró su parte sin haber pulsado «Atender»: solo se sabe a qué hora terminó, no cuánto duró.">
        No se cronometró
      </Pill>
    );
  }
  return (
    <Pill className="bg-slate-100 text-slate-600 ring-slate-200" title="Más de 4 horas (o cero): la atención se quedó abierta. No cuenta en el promedio.">
      {fmtMin(a.minutos)} · no cuenta
    </Pill>
  );
}

function TablaAtenciones({ atenciones, mostrarDoctor }) {
  return (
    <div className="md:bg-white md:rounded-xl md:border md:border-slate-200 overflow-hidden">
      <div className="md:overflow-x-auto">
        <table className="tbl tbl-cards text-sm">
          <thead>
            <tr className="bg-slate-50 text-slate-600 text-xs">
              <th className="text-left">Atención del doctor</th>
              <th className="text-left">Paciente</th>
              <th className="text-left">Cita agendada</th>
              <th className="text-left">Llegó</th>
              <th className="text-right">Duración</th>
            </tr>
          </thead>
          <tbody>
            {atenciones.map((a) => {
              const agendada = instanteAgendado(a.fecha, a.hora);
              const inicioMs = a.inicio ? new Date(a.inicio).getTime() : null;
              const retraso = agendada && inicioMs ? Math.round((inicioMs - agendada) / 60000) : null;
              return (
                <tr key={`${a.appointmentId}-${a.doctorId}-${a.inicio || a.fin}`}>
                  <td data-cell="hora" className="md:whitespace-nowrap tabular-nums">
                    <span className="font-semibold text-slate-800">
                      {a.inicio && a.fin && `${fmtTimeEc(a.inicio)} – ${fmtTimeEc(a.fin)}`}
                      {!a.inicio && a.fin && `Terminó a las ${fmtTimeEc(a.fin)}`}
                      {a.inicio && !a.fin && `Desde las ${fmtTimeEc(a.inicio)}`}
                    </span>
                    <span className="block text-[11px] font-normal text-slate-500">{fmtDate(a.inicio || a.fin || a.fecha)}</span>
                  </td>
                  <td data-cell="principal">
                    <span className="font-medium text-slate-800">{a.paciente || 'Paciente'}</span>
                    <span className="block text-[11px] text-slate-500">
                      {[mostrarDoctor ? a.doctor : null, a.servicio, a.sucursal].filter(Boolean).join(' · ')}
                    </span>
                  </td>
                  <td data-cell="detalle" className="md:whitespace-nowrap">
                    <span className="md:hidden text-slate-500">Agendada: </span>
                    {fmtDate(a.fecha)}{a.hora ? ` · ${a.hora}` : ''}
                    {retraso !== null && Math.abs(retraso) >= 15 && (
                      <span className={`block text-[11px] ${retraso > 0 ? 'text-amber-700' : 'text-sky-700'}`}>
                        {retraso > 0 ? `atendida ${fmtMin(retraso)} después` : `atendida ${fmtMin(-retraso)} antes`}
                      </span>
                    )}
                    {/* En el móvil la llegada va aquí: la columna propia se oculta. */}
                    {a.llegada && <span className="md:hidden block text-slate-500">Llegó: {fmtTimeEc(a.llegada)}</span>}
                  </td>
                  <td data-cell="fecha" className="md:whitespace-nowrap tabular-nums text-slate-600">
                    {a.llegada ? fmtTimeEc(a.llegada) : '—'}
                  </td>
                  <td data-cell="estado" className="md:text-right">
                    <Duracion a={a} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function DoctorTimes() {
  const hoy = todayEc();
  const [desde, setDesde] = useState(hoy);
  const [hasta, setHasta] = useState(hoy);
  const [doctorId, setDoctorId] = useState('');
  const [orden, setOrden] = useState('recientes');
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [ahoraMs, setAhoraMs] = useState(Date.now());
  const [ayuda, setAyuda] = useState(false);
  const peticion = useRef(0);

  const cargar = async ({ silencioso = false } = {}) => {
    const mia = ++peticion.current;
    if (!silencioso) setCargando(true);
    try {
      const { data: r } = await api.get('/reports/doctor-times', { params: { startDate: desde, endDate: hasta } });
      if (mia !== peticion.current) return;
      setData(r);
      setAhoraMs(Date.now());
    } catch (err) {
      if (mia !== peticion.current) return;
      if (!silencioso) toast.error(err.response?.data?.message || 'No se pudieron cargar los tiempos');
    } finally {
      if (mia === peticion.current) setCargando(false);
    }
  };

  // La ref apunta siempre a la carga del render actual (con el rango elegido):
  // el socket y el intervalo se suscriben una vez.
  const cargarRef = useRef(cargar);
  cargarRef.current = cargar;

  useEffect(() => {
    cargar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desde, hasta]);

  useEffect(() => {
    const reloj = setInterval(() => setAhoraMs(Date.now()), 30000);
    const recarga = setInterval(() => {
      if (document.visibilityState !== 'hidden') cargarRef.current({ silencioso: true });
    }, 60000);
    return () => {
      clearInterval(reloj);
      clearInterval(recarga);
    };
  }, []);

  // Un cambio de cita (alguien pulsó «Atender», cerró, asignaron) se refleja ya.
  const timer = useRef(null);
  const alCambiar = () => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => cargarRef.current({ silencioso: true }), 1500);
  };
  useEffect(() => () => clearTimeout(timer.current), []);
  useSocketEvent('appointment:created', alCambiar);
  useSocketEvent('appointment:updated', alCambiar);
  useSocketEvent('appointment:deleted', alCambiar);

  const rapido = (dias) => {
    setHasta(hoy);
    setDesde(dias ? sumarDias(hoy, -dias + 1) : hoy);
  };
  const ayer = () => {
    const y = sumarDias(hoy, -1);
    setDesde(y);
    setHasta(y);
  };

  const todos = useMemo(() => data?.doctores || [], [data]);
  // Para el selector: los que tienen algo que ver primero, luego el resto.
  const opcionesDoctor = useMemo(
    () => [...todos].sort((a, b) => a.name.localeCompare(b.name, 'es')),
    [todos]
  );
  const vistos = useMemo(
    () => (doctorId ? todos.filter((d) => String(d._id) === String(doctorId)) : todos),
    [todos, doctorId]
  );
  const elegido = doctorId ? todos.find((d) => String(d._id) === String(doctorId)) : null;

  const atenciones = useMemo(() => {
    const lista = vistos.flatMap((d) => d.atenciones.map((a) => ({ ...a, doctor: d.name })));
    return lista.sort(ORDENES[orden].fn);
  }, [vistos, orden]);

  // KPIs de lo que se está mirando (todos o un doctor).
  const kpi = useMemo(() => {
    const validas = atenciones.filter((a) => a.valida);
    const total = validas.reduce((s, a) => s + a.minutos, 0);
    return {
      enConsulta: vistos.filter((d) => d.ahora?.estado === 'en_consulta').length,
      esperando: vistos.reduce((s, d) => s + d.proximas.filter((p) => p.tipo === 'esperando').length, 0),
      atenciones: atenciones.length,
      conTiempo: validas.length,
      sinCronometro: atenciones.filter((a) => a.motivo === 'sin_cronometro').length,
      promedio: validas.length ? total / validas.length : null,
    };
  }, [vistos, atenciones]);

  const incluyeHoy = hasta >= hoy && desde <= hoy;
  const esHoy = desde === hoy && hasta === hoy;
  const rangoTexto = desde === hasta ? fmtDate(desde) : `${fmtDate(desde)} al ${fmtDate(hasta)}`;
  const botonRango = (activo) => `px-2.5 py-1.5 rounded-lg text-xs font-medium border cursor-pointer ${
    activo ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
  }`;

  return (
    <div className="space-y-5 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="m-0 text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineClock className="text-emerald-600" /> Tiempos de Doctores
          </h1>
          <p className="m-0 mt-0.5 text-xs text-slate-500">
            Cuánto dura cada atención y qué está haciendo cada doctor ahora.
            {data?.generadoEn && ` Actualizado a las ${fmtTimeEc(data.generadoEn)}; se actualiza solo.`}
          </p>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setAyuda((v) => !v)}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-slate-700 bg-white border border-slate-200 cursor-pointer"
          >
            <HiOutlineInformationCircle className="w-4 h-4" /> ¿Cómo se mide?
          </button>
          <button
            type="button"
            onClick={() => cargar()}
            disabled={cargando}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-slate-700 bg-white border border-slate-200 cursor-pointer disabled:opacity-50"
          >
            <HiOutlineArrowPath className={`w-4 h-4 ${cargando ? 'animate-spin' : ''}`} /> Actualizar
          </button>
        </div>
      </div>

      {ayuda && (
        <div className="rounded-xl border border-sky-200 bg-sky-50 p-3 text-xs text-sky-900 space-y-1">
          <p className="m-0"><b>Cita agendada</b>: la hora que se reservó para el paciente.</p>
          <p className="m-0"><b>Llegó</b>: cuando recepción recibió al paciente y le asignó la atención.</p>
          <p className="m-0"><b>Atención del doctor</b>: desde que el doctor pulsó «Atender» hasta que cerró su parte. Es lo que se mide.</p>
          <p className="m-0"><b>No se cronometró</b>: el doctor cerró sin pulsar «Atender», así que solo se sabe a qué hora terminó. No cuenta en el promedio.</p>
          <p className="m-0"><b>No cuenta</b>: más de 4 horas — la atención se quedó abierta y alguien la cerró después.</p>
        </div>
      )}

      {/* FILTROS: fechas y doctor, en una sola fila. */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap gap-3 items-end">
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={() => rapido(0)} className={botonRango(esHoy)}>Hoy</button>
          <button type="button" onClick={ayer} className={botonRango(desde === hasta && desde === sumarDias(hoy, -1))}>Ayer</button>
          <button type="button" onClick={() => rapido(7)} className={botonRango(hasta === hoy && desde === sumarDias(hoy, -6))}>7 días</button>
          <button type="button" onClick={() => rapido(30)} className={botonRango(hasta === hoy && desde === sumarDias(hoy, -29))}>30 días</button>
        </div>
        <label className="text-xs text-slate-600">
          Desde
          <DateInput value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
        </label>
        <label className="text-xs text-slate-600">
          Hasta
          <DateInput value={hasta} min={desde} max={hoy} onChange={(e) => setHasta(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
        </label>
        <div className="text-xs text-slate-600 min-w-[240px] flex-1 max-w-sm">
          Doctor
          <div className="mt-1">
            <SearchableSelect
              options={opcionesDoctor}
              value={doctorId}
              onChange={(v) => setDoctorId(v || '')}
              getLabel={(d) => (d.specialty ? `${d.name} · ${d.specialty}` : d.name)}
              getSearchText={(d) => `${d.name || ''} ${d.specialty || ''}`}
              placeholder="Todos los doctores"
              searchPlaceholder="Buscar doctor…"
              allowClear
            />
          </div>
        </div>
      </div>

      {elegido && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-3 py-2">
          <span className="text-sm text-emerald-900 inline-flex items-center gap-1.5">
            <HiOutlineUserCircle className="w-5 h-5" /> Viendo solo a <b>{elegido.name}</b>
          </span>
          <button type="button" onClick={() => setDoctorId('')} className="inline-flex items-center gap-1 text-xs text-emerald-800 bg-transparent border-none cursor-pointer">
            <HiOutlineXMark className="w-4 h-4" /> Ver todos
          </button>
        </div>
      )}

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Kpi label="En consulta ahora" value={kpi.enConsulta} />
        <Kpi label="Pacientes esperando" value={kpi.esperando} sub="ya llegaron y les toca" />
        <Kpi label={esHoy ? 'Atenciones de hoy' : 'Atenciones del rango'} value={kpi.atenciones} sub={rangoTexto} />
        <Kpi
          label="Promedio por atención"
          value={fmtMin(kpi.promedio)}
          sub={kpi.atenciones ? `medido en ${kpi.conTiempo} de ${kpi.atenciones}` : null}
        />
      </div>

      {cargando && !data && <p className="text-sm text-slate-500">Cargando…</p>}

      {data && incluyeHoy && (
        <Seccion titulo="Ahora mismo" sub="Quién está atendiendo y qué pacientes le quedan hoy, por hora de la cita.">
          <Ahora doctores={vistos} ahoraMs={ahoraMs} />
        </Seccion>
      )}

      {data && !doctorId && (
        <Seccion titulo="Resumen por doctor" sub={`${rangoTexto} · pulsa un doctor para ver solo sus atenciones.`}>
          <ResumenPorDoctor doctores={todos} onElegir={setDoctorId} />
        </Seccion>
      )}

      {data && (
        <Seccion
          titulo={`Atenciones (${atenciones.length})`}
          sub={`${rangoTexto} · ordenadas por ${ORDENES[orden].label.toLowerCase()}.`}
          derecha={(
            <label className="text-xs text-slate-600 flex items-center gap-2">
              Ordenar por
              <select value={orden} onChange={(e) => setOrden(e.target.value)} className="border border-slate-200 rounded-lg px-2 py-1.5 text-sm bg-white">
                {Object.entries(ORDENES).map(([k, o]) => <option key={k} value={k}>{o.label}</option>)}
              </select>
            </label>
          )}
        >
          {kpi.sinCronometro > 0 && (
            <p className="m-0 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              {kpi.sinCronometro} {kpi.sinCronometro === 1 ? 'atención no se cronometró' : 'atenciones no se cronometraron'}:
              el doctor cerró sin pulsar «Atender». Para medirlas, el doctor debe pulsar «Atender» al recibir al paciente.
            </p>
          )}
          {atenciones.length ? (
            <TablaAtenciones atenciones={atenciones} mostrarDoctor={!doctorId} />
          ) : (
            <p className="m-0 text-sm text-slate-500 bg-white rounded-xl border border-slate-200 p-6 text-center">
              {elegido ? `${elegido.name} no tiene atenciones terminadas en estas fechas.` : 'No hay atenciones terminadas en estas fechas.'}
            </p>
          )}
        </Seccion>
      )}
    </div>
  );
}
