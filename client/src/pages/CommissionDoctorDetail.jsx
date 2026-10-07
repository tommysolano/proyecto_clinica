import { useEffect, useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArrowLeft, HiOutlineCurrencyDollar, HiOutlineUserGroup, HiOutlineArrowsRightLeft } from 'react-icons/hi2';
import { fmtDate } from '../utils/date';
import DateInput from '../components/DateInput';
import Paginador from '../components/Paginador';
import ProductAutocomplete from '../components/ProductAutocomplete';
import { doctorOptionLabel } from '../utils/roles';
import {
  STATUS_COLORS,
  STATUS_OPTIONS,
  DERIVACION_ESTADOS,
  fmtAtendientes,
  fmtPago,
  money,
  statusLabel,
  doctorSearchOption,
} from '../utils/commissionsFormat';

const lista = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Citas por página: con todos los doctores de un mes salían miles de filas de golpe.
const POR_PAGINA = 200;

function EstadoDerivacion({ estado }) {
  const e = DERIVACION_ESTADOS[estado] || { label: estado, cls: 'bg-slate-100 text-slate-500' };
  return <span className={`px-2 py-0.5 rounded-full font-semibold whitespace-nowrap ${e.cls}`}>{e.label}</span>;
}

export default function CommissionDoctorDetail() {
  const { doctorId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  /**
   * EL DETALLE GENERAL (sep-2026): `/commissions/todos` enseña TODAS las citas
   * de todos los doctores —la misma información del detalle de un doctor, pero
   * sin el corte por profesional—, con sus propios filtros de doctor (con
   * buscador), sucursal y fechas, además de los estados y servicios que vienen
   * de la pantalla de Comisiones.
   */
  const esGeneral = doctorId === 'todos';
  // Comisiones > Enfermería abre este mismo detalle con `area=enfermeria` (oct-2026):
  // las citas de los enfermeros, sin derivaciones (enfermería no deriva).
  const esEnf = searchParams.get('area') === 'enfermeria';
  const area = esEnf ? 'enfermeria' : undefined;
  const persona = esEnf ? 'enfermero/a' : 'doctor';
  const Persona = esEnf ? 'Enfermero/a' : 'Doctor';
  // Sin «Dr.» para enfermería: el título es solo de los médicos.
  const etiqueta = (d) => (esEnf ? d?.name || '' : doctorOptionLabel(d));
  const doctorName = searchParams.get('name') || Persona;
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [clinics, setClinics] = useState([]);
  const [doctors, setDoctors] = useState([]);

  // Los filtros viven en la URL: el enlace se puede compartir o recargar tal cual.
  const start = searchParams.get('start') || '';
  const end = searchParams.get('end') || '';
  const clinic = searchParams.get('clinic') || 'all';
  const doctorFilter = lista(searchParams.get('doctor'));
  const statusFilter = lista(searchParams.get('status'));

  const page = Math.max(parseInt(searchParams.get('page'), 10) || 1, 1);
  const irAPagina = (n) => {
    const next = new URLSearchParams(searchParams);
    if (n <= 1) next.delete('page');
    else next.set('page', String(n));
    setSearchParams(next, { replace: true });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // Cambiar un filtro vuelve a la página 1: la página 7 de otro filtro no existe.
  const setParam = (key, value) => {
    const next = new URLSearchParams(searchParams);
    if (key !== 'page') next.delete('page');
    if (value == null || value === '' || (Array.isArray(value) && !value.length)) next.delete(key);
    else next.set(key, Array.isArray(value) ? value.join(',') : value);
    setSearchParams(next, { replace: true });
  };

  useEffect(() => {
    api.get('/clinics').then((r) => setClinics(r.data || [])).catch(() => {});
  }, []);

  useEffect(() => {
    if (!esGeneral) return;
    api.get('/commissions/doctors', { params: { clinic, area } })
      .then((r) => setDoctors(r.data || []))
      .catch(() => setDoctors([]));
  }, [clinic, esGeneral, area]);

  useEffect(() => {
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const params = { limit: POR_PAGINA, page };
        ['start', 'end', 'clinic', 'status', 'service', 'area'].forEach((k) => {
          if (searchParams.get(k)) params[k] = searchParams.get(k);
        });
        // El corte por doctor: el de la URL en el modo individual, y el del
        // filtro (si lo hay) en el general.
        if (!esGeneral) params.doctor = doctorId;
        else if (doctorFilter.length) params.doctor = doctorFilter.join(',');
        const res = await api.get('/commissions/doctor-appointments', { params });
        setData(res.data);
      } catch (err) {
        toast.error(err.response?.data?.message || 'Error al cargar el detalle');
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => clearTimeout(t);
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, [doctorId, searchParams.toString()]);

  const citas = data?.appointments || [];
  /**
   * Las derivaciones: del doctor en el modo individual; TODAS, aplanadas, en el
   * general (cada fila lleva quién derivó).
   */
  const derivaciones = useMemo(() => (esGeneral
    ? Object.values(data?.referralsByDoctor || {}).flat()
    : data?.referralsByDoctor?.[doctorId] || []
  ).sort((a, b) => new Date(b.date) - new Date(a.date)), [data, esGeneral, doctorId]);
  const cuentaDeriva = (estados) => derivaciones.filter((d) => estados.includes(d.estado)).length;
  const nombreReal = data?.doctorNames?.[doctorId] || doctorName;
  const totalPagos = Number(data?.totals?.payments || 0);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-sm">
        <Link
          to={esEnf ? '/commissions?tab=enfermeria' : '/commissions'}
          className="inline-flex items-center gap-1 text-emerald-600 hover:underline bg-transparent border-none cursor-pointer"
        >
          <HiOutlineArrowLeft className="w-4 h-4" /> Volver a Comisiones
        </Link>
      </div>

      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
        {esGeneral ? (
          <>
            <HiOutlineUserGroup className="text-emerald-600" /> Citas de todos los {esEnf ? 'enfermeros' : 'doctores'}
          </>
        ) : (
          <>
            <HiOutlineCurrencyDollar className="text-emerald-600" /> Citas de {nombreReal}
          </>
        )}
      </h1>

      <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-sm">Desde
            <DateInput value={start} onChange={(e) => setParam('start', e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
          </label>
          <label className="text-sm">Hasta
            <DateInput value={end} onChange={(e) => setParam('end', e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
          </label>
          <label className="text-sm">Sucursal
            <select
              value={clinic}
              onChange={(e) => {
                const next = new URLSearchParams(searchParams);
                next.set('clinic', e.target.value);
                next.delete('page');
                if (esGeneral) next.delete('doctor');
                setSearchParams(next, { replace: true });
              }}
              className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm min-w-[180px]"
            >
              <option value="all">Todas las sucursales</option>
              {clinics.map((c) => (
                <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>
              ))}
            </select>
          </label>
          {esGeneral && (
            <label className="text-sm">{Persona}
              <div className="mt-1 min-w-[260px]">
                {/* Se escribe el nombre o la especialidad; debajo de cada
                    doctor sale su rol (general o especialidad). */}
                <ProductAutocomplete
                  products={doctors
                    .filter((d) => !doctorFilter.includes(String(d._id)))
                    .map(doctorSearchOption)}
                  value=""
                  onSelect={(p) => {
                    if (p && !doctorFilter.includes(String(p._id))) setParam('doctor', [...doctorFilter, String(p._id)]);
                  }}
                  placeholder={esEnf ? 'Escribe un enfermero...' : 'Escribe un doctor o especialidad...'}
                />
              </div>
            </label>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-slate-500">Estados:</span>
          {STATUS_OPTIONS.map((s) => {
            const activos = statusFilter.length ? statusFilter : ['asistida', 'completada'];
            const on = activos.includes(s.value);
            return (
              <button
                key={s.value}
                type="button"
                onClick={() => setParam('status', on ? activos.filter((x) => x !== s.value) : [...activos, s.value])}
                className={`px-2.5 py-1 rounded-full text-xs cursor-pointer border-none ${
                  on ? `${STATUS_COLORS[s.value]} font-semibold` : 'bg-slate-50 text-slate-400 border border-slate-200'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>

        {esGeneral && doctorFilter.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {doctorFilter.map((id) => (
              <span key={id} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-slate-100 text-xs text-slate-700">
                {etiqueta(doctors.find((d) => String(d._id) === id) || { name: data?.doctorNames?.[id] || Persona, roleInClinic: '' })}
                <button
                  type="button"
                  onClick={() => setParam('doctor', doctorFilter.filter((x) => x !== id))}
                  className="text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer leading-none"
                >
                  ✕
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setParam('doctor', [])}
              className="text-xs text-emerald-600 hover:underline bg-transparent border-none cursor-pointer px-1"
            >
              Quitar {esEnf ? 'enfermeros' : 'doctores'}
            </button>
          </div>
        )}
      </div>

      {data && (
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-sm text-slate-500">
            {fmtDate(data.start)} — {fmtDate(data.end)} · <b>{data.totals?.appointments ?? citas.length}</b> citas en el filtro
          </p>
          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 text-emerald-800 px-3 py-1 text-sm font-semibold">
            Total pagos: {money(totalPagos)}
          </span>
          {derivaciones.length > 0 && (
            <span className="inline-flex items-center gap-1 rounded-full bg-violet-100 text-violet-800 px-3 py-1 text-sm font-semibold">
              Derivaciones{data.pagination?.pages > 1 ? ' (esta página)' : ''}: {derivaciones.length} · realizadas {cuentaDeriva(['realizada'])} · sin realizar {cuentaDeriva(['sin_agendar', 'no_asistio', 'cancelada'])}
            </span>
          )}
        </div>
      )}

      {loading && <div className="text-slate-500">Cargando...</div>}

      {data && <Paginador pagination={data.pagination} onPage={irAPagina} unidad="citas" />}

      {data && (
        <div className="space-y-4">
          {citas.length > 0 ? (
            <div className="overflow-x-auto bg-white rounded-xl border border-slate-200">
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="text-left px-3 py-2 whitespace-nowrap">Fecha</th>
                    <th className="text-left px-3 py-2">Paciente</th>
                    <th className="text-left px-3 py-2">Servicios</th>
                    <th className="text-left px-3 py-2">Estado</th>
                    <th className="text-left px-3 py-2">Atendida por</th>
                    <th className="text-left px-3 py-2">Pago</th>
                    <th className="text-left px-3 py-2">Seguimiento</th>
                    {!esEnf && <th className="text-left px-3 py-2">Derivaciones</th>}
                  </tr>
                </thead>
                <tbody>
                  {citas.map((a) => (
                    <tr key={a.id} className="border-t border-slate-100 align-top">
                      <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                        {fmtDate(a.date)}
                        {a.startTime ? <span className="text-slate-400"> {a.startTime}</span> : null}
                        {a.clinic ? <span className="block text-[10px] text-slate-400">{a.clinic}</span> : null}
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-slate-800 font-medium">{a.patient}</span>
                        {a.visitsTotal > 1 ? (
                          <span
                            title={`Este ${persona} atendió ${a.visitsTotal} veces a este paciente en el filtro`}
                            className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-semibold"
                          >
                            visita {a.visitNumber}/{a.visitsTotal}
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 text-slate-600">{a.services?.join(', ') || '—'}</td>
                      <td className="px-3 py-2">
                        <span className={`px-2 py-0.5 rounded-full font-semibold ${STATUS_COLORS[a.status] || 'bg-slate-100 text-slate-600'}`}>
                          {statusLabel(a.status)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-slate-600">
                        {fmtAtendientes(a) || '—'}
                        {/* En el detalle GENERAL la fila dice de quién era la
                            cita: es lo que sin esto no se sabría al mezclar
                            doctores. */}
                        {esGeneral && a.doctorName && (
                          <span className="block text-[10px] text-emerald-700 font-semibold mt-0.5">
                            {esEnf ? a.doctorName : `Dr. ${a.doctorName}`}
                          </span>
                        )}
                        {a.multiprofesional && (
                          <span className="block text-[10px] text-amber-700 font-semibold mt-0.5">
                            Atendida por {a.atendientes.filter((t) => t.kind === 'doctor').length} doctores
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{fmtPago(a)}</td>
                      <td className="px-3 py-2 min-w-[200px]">
                        {(a.seguimientos || []).length > 0 ? (
                          <div className="space-y-1">
                            {a.seguimientos.map((s, i) => (
                              <div key={i} className="bg-violet-50 border border-violet-200 rounded-lg px-2 py-1.5">
                                {s.motivoConsulta && (
                                  <div className="text-[10px] text-slate-400 uppercase tracking-wide mb-0.5">
                                    {s.motivoConsulta}
                                  </div>
                                )}
                                {s.sueros > 0 && (
                                  <div className="text-violet-700 text-xs">
                                    <b>Suero(s) recetados: ×{s.sueros}</b>
                                  </div>
                                )}
                                {(s.otros || []).length > 0 && (
                                  <div className="text-slate-600 text-xs">
                                    <span className="text-slate-400">Receta:</span> {s.otros.join(', ')}
                                  </div>
                                )}
                                {s.sueros === 0 && (s.otros || []).length === 0 && (
                                  <div className="text-[10px] text-slate-400">Seguimiento sin receta</div>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      {!esEnf && (
                      <td className="px-3 py-2 min-w-[190px]">
                        {(a.derivaciones || []).length > 0 ? (
                          <div className="space-y-1">
                            {a.derivaciones.map((d) => (
                              <div key={d.id} className="flex flex-col gap-0.5">
                                <span className="text-slate-700 font-medium">{d.service}</span>
                                <span><EstadoDerivacion estado={d.estado} /></span>
                                {d.cita && (
                                  <span className="text-[10px] text-slate-400">
                                    {fmtDate(d.cita.date)}{d.cita.doctor ? ` · ${d.cita.doctor}` : ''}
                                  </span>
                                )}
                              </div>
                            ))}
                          </div>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      )}
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-emerald-50 border-t-2 border-emerald-200">
                  {data.pagination?.pages > 1 && (
                    <tr>
                      <td colSpan={5} className="px-3 py-2 text-right font-semibold text-emerald-700">Pagos de esta página</td>
                      <td className="px-3 py-2 whitespace-nowrap font-semibold text-emerald-700">{money(data.totals?.pagePayments)}</td>
                      <td colSpan={esEnf ? 1 : 2}></td>
                    </tr>
                  )}
                  <tr>
                    <td colSpan={5} className="px-3 py-2 text-right font-semibold text-emerald-800">Total pagos del filtro</td>
                    <td className="px-3 py-2 whitespace-nowrap font-bold text-emerald-800">{money(totalPagos)}</td>
                    <td colSpan={esEnf ? 1 : 2}></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : (
            <div className="bg-white rounded-xl border border-slate-200 px-4 py-6 text-center text-slate-400">
              Sin citas en el período con los filtros aplicados.
            </div>
          )}

          <Paginador pagination={data.pagination} onPage={irAPagina} unidad="citas" />

          {!esEnf && (
          <div className="bg-white rounded-xl border border-slate-200 px-4 py-3">
            <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide mb-1 inline-flex items-center gap-1">
              <HiOutlineArrowsRightLeft className="w-3.5 h-3.5" /> Derivaciones de los doctores ({derivaciones.length})
            </p>
            <p className="text-[11px] text-slate-500 mb-2">
              El doctor gana la comisión de una derivación solo cuando el paciente se la realiza.
              {data.pagination?.pages > 1 && ' Se listan las derivaciones de las citas de esta página.'}
            </p>
            {derivaciones.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="text-slate-500">
                    <tr>
                      {esGeneral && <th className="text-left px-2 py-1">Doctor que derivó</th>}
                      <th className="text-left px-2 py-1">Paciente</th>
                      <th className="text-left px-2 py-1">Derivado a</th>
                      <th className="text-left px-2 py-1">Indicada</th>
                      <th className="text-left px-2 py-1">¿Se realizó?</th>
                      <th className="text-left px-2 py-1">Cita derivada</th>
                    </tr>
                  </thead>
                  <tbody>
                    {derivaciones.map((r) => (
                      <tr key={r.id} className="border-t border-slate-100 align-top">
                        {esGeneral && (
                          <td className="px-2 py-1.5 text-slate-800 font-medium">{r.fromDoctor || '—'}</td>
                        )}
                        <td className="px-2 py-1.5 text-slate-800">{r.patient}</td>
                        <td className="px-2 py-1.5 text-slate-600">
                          {r.service || r.specialty || '—'}
                          {r.toDoctor ? <span className="block text-[10px] text-slate-400">{r.toDoctor}</span> : null}
                          {r.reason ? <span className="block text-[10px] text-slate-400">{r.reason}</span> : null}
                        </td>
                        <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">{fmtDate(r.date)}</td>
                        <td className="px-2 py-1.5"><EstadoDerivacion estado={r.estado} /></td>
                        <td className="px-2 py-1.5 text-slate-500 whitespace-nowrap">
                          {r.cita ? (
                            <>
                              {fmtDate(r.cita.date)}{r.cita.startTime ? ` ${r.cita.startTime}` : ''}
                              <span className="block text-[10px] text-slate-400">
                                {statusLabel(r.cita.status)}{r.cita.clinic ? ` · ${r.cita.clinic}` : ''}
                              </span>
                            </>
                          ) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-slate-400">Sin derivaciones en las citas del filtro.</p>
            )}
          </div>
          )}
        </div>
      )}
    </div>
  );
}
