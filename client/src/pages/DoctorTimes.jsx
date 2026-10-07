import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  HiOutlineClock,
  HiOutlineArrowPath,
  HiOutlineChevronDown,
  HiOutlineChevronUp,
} from 'react-icons/hi2';
import api from '../api/axios';
import DateInput from '../components/DateInput';
import { fmtDate, fmtTimeEc, todayEc } from '../utils/date';
import { useSocketEvent } from '../context/SocketContext';

/**
 * TIEMPOS DE LOS DOCTORES (oct-2026, Fénix).
 *
 * Por doctor: cuánto tardó en cada atención del rango, su promedio, y qué está
 * haciendo AHORA — en consulta (y desde cuándo), con un paciente esperando, en
 * cola detrás de otro profesional o con citas agendadas para hoy. El cálculo es
 * del servidor (`GET /reports/doctor-times`, ver utils/tiemposDoctores.js).
 *
 * El «ahora» se mantiene vivo solo: se recarga con cada cambio de cita que llega
 * por socket y cada minuto, y los minutos en consulta corren en pantalla.
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

const PROXIMA = {
  esperando: { label: 'Esperando', tono: 'bg-amber-50 text-amber-800 ring-amber-200', ayuda: 'El paciente ya está en la clínica y le toca a este doctor' },
  en_cola: { label: 'En cola', tono: 'bg-sky-50 text-sky-800 ring-sky-200', ayuda: 'Le llega cuando termine el profesional que va antes' },
  agendada: { label: 'Agendada', tono: 'bg-slate-100 text-slate-700 ring-slate-200', ayuda: 'Cita de hoy; el paciente aún no llega' },
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
    <div className="bg-white rounded-xl border border-slate-200 px-3 py-2.5">
      <p className="m-0 text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="m-0 mt-0.5 text-xl font-bold text-slate-800 tabular-nums">{value}</p>
      {sub && <p className="m-0 text-[11px] text-slate-500">{sub}</p>}
    </div>
  );
}

function DoctorCard({ d, ahoraMs }) {
  const [abierto, setAbierto] = useState(false);
  const enConsulta = d.ahora?.estado === 'en_consulta';
  // Los minutos en consulta corren en pantalla, no solo al recargar.
  const minutos = enConsulta && d.ahora.desde
    ? Math.max(0, Math.round((ahoraMs - new Date(d.ahora.desde).getTime()) / 60000))
    : 0;
  const r = d.resumen || {};
  const visibles = d.proximas.slice(0, 4);

  return (
    <div className="bg-white rounded-xl border border-slate-200 p-3 sm:p-4 flex flex-col gap-2.5 min-w-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="m-0 font-semibold text-slate-800 break-words">{d.name}</p>
          {d.specialty && <p className="m-0 text-xs text-slate-500">{d.specialty}</p>}
        </div>
        {enConsulta ? (
          <Pill className={tonoMinutos(minutos)} title="Tiempo desde que pulsó «Atender»">
            ● En consulta · {fmtMin(minutos)}
          </Pill>
        ) : (
          <Pill className="bg-slate-50 text-slate-500 ring-slate-200">Libre</Pill>
        )}
      </div>

      {enConsulta && (
        <p className="m-0 text-xs text-slate-700">
          Con <b>{d.ahora.paciente || 'paciente'}</b> desde {fmtTimeEc(d.ahora.desde)}
          {d.ahora.servicio ? ` · ${d.ahora.servicio}` : ''}
          {d.ahora.sucursal ? ` · ${d.ahora.sucursal}` : ''}
        </p>
      )}

      {d.proximas.length > 0 && (
        <div>
          <p className="m-0 mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">Próximos de hoy</p>
          <ul className="m-0 p-0 list-none space-y-1">
            {visibles.map((p) => {
              const t = PROXIMA[p.tipo] || PROXIMA.agendada;
              return (
                <li key={`${p.appointmentId}-${p.tipo}`} className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-slate-700">
                  <Pill className={t.tono} title={t.ayuda}>{t.label}</Pill>
                  {p.hora && <span className="tabular-nums text-slate-500">{p.hora}</span>}
                  <span className="font-medium break-words">{p.paciente || 'Paciente'}</span>
                  {p.tipo === 'en_cola' && p.antes?.nombre && (
                    <span className="text-sky-700">después de {p.antes.nombre}</span>
                  )}
                  {p.servicio && <span className="text-slate-500">· {p.servicio}</span>}
                </li>
              );
            })}
          </ul>
          {d.proximas.length > visibles.length && (
            <p className="m-0 mt-1 text-[11px] text-slate-500">y {d.proximas.length - visibles.length} más</p>
          )}
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 rounded-lg bg-slate-50 px-2.5 py-2 text-center">
        <div>
          <p className="m-0 text-[10px] uppercase tracking-wide text-slate-500">Atenciones</p>
          <p className="m-0 font-bold text-slate-800 tabular-nums">{r.atenciones || 0}</p>
        </div>
        <div>
          <p className="m-0 text-[10px] uppercase tracking-wide text-slate-500">Promedio</p>
          <p className="m-0 font-bold text-slate-800 tabular-nums">{fmtMin(r.promedioMin)}</p>
        </div>
        <div>
          <p className="m-0 text-[10px] uppercase tracking-wide text-slate-500">Más corta</p>
          <p className="m-0 font-semibold text-slate-700 tabular-nums">{fmtMin(r.minMin)}</p>
        </div>
        <div>
          <p className="m-0 text-[10px] uppercase tracking-wide text-slate-500">Más larga</p>
          <p className="m-0 font-semibold text-slate-700 tabular-nums">{fmtMin(r.maxMin)}</p>
        </div>
      </div>
      {(r.sinCronometro > 0 || r.atipicas > 0) && (
        <p className="m-0 text-[11px] text-amber-700">
          {r.sinCronometro > 0 && `${r.sinCronometro} sin tiempo (cerró sin pulsar «Atender»)`}
          {r.sinCronometro > 0 && r.atipicas > 0 && ' · '}
          {r.atipicas > 0 && `${r.atipicas} de más de 4 h (se quedó abierta)`}
          {' — no cuentan en el promedio.'}
        </p>
      )}

      {d.atenciones.length > 0 && (
        <button
          type="button"
          onClick={() => setAbierto((v) => !v)}
          className="self-start inline-flex items-center gap-1 text-xs font-medium text-emerald-700 hover:text-emerald-800 bg-transparent border-none cursor-pointer p-0"
        >
          {abierto ? <HiOutlineChevronUp className="w-4 h-4" /> : <HiOutlineChevronDown className="w-4 h-4" />}
          {abierto ? 'Ocultar atenciones' : `Ver cada atención (${d.atenciones.length})`}
        </button>
      )}

      {abierto && (
        <div className="overflow-x-auto md:rounded-lg md:border md:border-slate-200">
          <table className="tbl tbl-cards text-xs">
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Paciente</th>
                <th>Inicio – fin</th>
                <th className="text-right">Duración</th>
              </tr>
            </thead>
            <tbody>
              {d.atenciones.map((a) => (
                <tr key={`${a.appointmentId}-${a.inicio || a.fin}`}>
                  <td data-cell="hora" className="whitespace-nowrap">
                    {fmtDate(a.fecha)}{a.hora ? ` · ${a.hora}` : ''}
                  </td>
                  <td data-cell="principal">
                    <span className="font-medium">{a.paciente || 'Paciente'}</span>
                    {a.servicio && <span className="block text-slate-500">{a.servicio}</span>}
                  </td>
                  <td data-cell="detalle" className="whitespace-nowrap tabular-nums">
                    {a.inicio ? fmtTimeEc(a.inicio) : '—'} – {a.fin ? fmtTimeEc(a.fin) : '—'}
                  </td>
                  <td data-cell="estado" className="md:text-right whitespace-nowrap font-semibold tabular-nums">
                    {a.valida ? (
                      fmtMin(a.minutos)
                    ) : (
                      <span className="text-amber-700 font-normal">
                        {a.motivo === 'sin_cronometro' ? 'sin tiempo' : `${fmtMin(a.minutos)} (no cuenta)`}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default function DoctorTimes() {
  const hoy = todayEc();
  const [desde, setDesde] = useState(hoy);
  const [hasta, setHasta] = useState(hoy);
  const [data, setData] = useState(null);
  const [cargando, setCargando] = useState(false);
  const [verTodos, setVerTodos] = useState(false);
  const [ahoraMs, setAhoraMs] = useState(Date.now());
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

  const doctores = useMemo(() => {
    const lista = data?.doctores || [];
    if (verTodos) return lista;
    return lista.filter((d) => d.ahora?.estado === 'en_consulta' || d.proximas.length || d.atenciones.length);
  }, [data, verTodos]);
  const ocultos = (data?.doctores?.length || 0) - doctores.length;
  const r = data?.resumen || {};
  const esHoy = desde === hoy && hasta === hoy;

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="m-0 text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineClock className="text-emerald-600" /> Tiempos de Doctores
          </h1>
          <p className="m-0 mt-0.5 text-xs text-slate-500">
            Cuánto tarda cada doctor por atención y qué está haciendo ahora.
            {data?.generadoEn && ` Actualizado ${fmtTimeEc(data.generadoEn)} · se actualiza solo.`}
          </p>
        </div>
        <button
          type="button"
          onClick={() => cargar()}
          disabled={cargando}
          className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-sm font-medium text-slate-700 bg-white border border-slate-200 cursor-pointer disabled:opacity-50"
        >
          <HiOutlineArrowPath className={`w-4 h-4 ${cargando ? 'animate-spin' : ''}`} /> Actualizar
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap gap-3 items-end">
        <label className="text-sm">
          Desde
          <DateInput value={desde} max={hasta} onChange={(e) => setDesde(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
        </label>
        <label className="text-sm">
          Hasta
          <DateInput value={hasta} min={desde} max={hoy} onChange={(e) => setHasta(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
        </label>
        <div className="flex flex-wrap gap-1.5">
          {[[0, 'Hoy'], [7, '7 días'], [30, '30 días']].map(([n, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => rapido(n)}
              className="px-2.5 py-1.5 rounded-lg text-xs font-medium border border-slate-200 bg-white text-slate-600 cursor-pointer hover:border-slate-300"
            >
              {label}
            </button>
          ))}
        </div>
        <label className="ml-auto flex items-center gap-2 text-xs text-slate-600 cursor-pointer select-none">
          <input type="checkbox" checked={verTodos} onChange={(e) => setVerTodos(e.target.checked)} />
          Ver también los doctores sin actividad
        </label>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-2">
        <Kpi label="En consulta ahora" value={r.enConsulta ?? '—'} />
        <Kpi label="Con paciente esperando" value={r.conPacientesEsperando ?? '—'} />
        <Kpi label={esHoy ? 'Atenciones hoy' : 'Atenciones del rango'} value={r.atenciones ?? '—'} />
        <Kpi
          label="Promedio por atención"
          value={fmtMin(r.promedioMin)}
          sub={r.conTiempo != null ? `sobre ${r.conTiempo} con tiempo` : null}
        />
      </div>

      {cargando && !data && <p className="text-sm text-slate-500">Cargando…</p>}

      {data && doctores.length === 0 && (
        <p className="text-sm text-slate-500 bg-white rounded-xl border border-slate-200 p-6 text-center">
          Ningún doctor tiene atenciones en estas fechas ni pacientes hoy.
        </p>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        {doctores.map((d) => (
          <DoctorCard key={d._id} d={d} ahoraMs={ahoraMs} />
        ))}
      </div>

      {!verTodos && ocultos > 0 && (
        <p className="text-xs text-slate-500 text-center">
          {ocultos} {ocultos === 1 ? 'doctor sin actividad oculto' : 'doctores sin actividad ocultos'}.
        </p>
      )}
    </div>
  );
}
