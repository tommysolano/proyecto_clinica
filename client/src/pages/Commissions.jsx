import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCurrencyDollar, HiOutlineChevronDown } from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import ProductAutocomplete from '../components/ProductAutocomplete';
import { doctorOptionLabel } from '../utils/roles';
import { fmtDate } from '../utils/date';

const STATUS_OPTIONS = [
  { value: 'pendiente', label: 'Pendiente' },
  { value: 'confirmada', label: 'Confirmada' },
  { value: 'asistida', label: 'Asistida' },
  { value: 'no_asistio', label: 'No asistió' },
  { value: 'cancelada', label: 'Cancelada' },
  { value: 'completada', label: 'Completada' },
];

const STATUS_COLORS = {
  pendiente: 'bg-slate-100 text-slate-700',
  confirmada: 'bg-blue-100 text-blue-700',
  asistida: 'bg-emerald-100 text-emerald-700',
  no_asistio: 'bg-amber-100 text-amber-700',
  cancelada: 'bg-red-100 text-red-700',
  completada: 'bg-teal-100 text-teal-700',
};

const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

const fmtPago = (a) => {
  if (a.payment?.isCanje) return 'Canje';
  const partes = [];
  if (a.payment?.agreedValue != null) partes.push(`$${Number(a.payment.agreedValue).toFixed(2)}`);
  const adv = a.payment?.advancePayment;
  const monto = Number(a.payment?.advanceAmount || 0).toFixed(2);
  const metodo = a.payment?.advanceMethod ? ` (${a.payment.advanceMethod})` : '';
  if (adv === 'abono') partes.push(`abono $${monto}${metodo}`);
  else if (adv === 'total') partes.push(`pagada por adelantado $${monto}${metodo}`);
  if (a.venta) partes.push(`Venta ${a.venta.number || ''} · ${fmtDate(a.venta.date)}`.replace(' ·  ', ' · '));
  return partes.length ? partes.join(' · ') : 'Sin valor registrado';
};

const fmtAtendientes = (a) =>
  (a.atendientes || [])
    .map((t) => `${t.name}${t.kind === 'enfermeria' ? ' (enfermería)' : ''}`)
    .join(' → ');

export default function Commissions() {
  const [start, setStart] = useState(monthAgo());
  const [end, setEnd] = useState(today());
  const [clinic, setClinic] = useState('all');
  const [doctorFilter, setDoctorFilter] = useState([]);
  const [statusFilter, setStatusFilter] = useState(['asistida', 'completada']);
  const [serviceFilter, setServiceFilter] = useState([]);
  const [clinics, setClinics] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [services, setServices] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState({});
  const [detalles, setDetalles] = useState({});

  const filtrosActuales = () => {
    const params = { start, end, clinic };
    if (doctorFilter.length) params.doctor = doctorFilter.join(',');
    if (statusFilter.length) params.status = statusFilter.join(',');
    if (serviceFilter.length) params.service = serviceFilter.join(',');
    return params;
  };

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/commissions/doctor-summary', { params: filtrosActuales() });
      setData(res.data);
      setExpanded({});
      setDetalles({});
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar el resumen');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.get('/clinics').then((r) => setClinics(r.data || [])).catch(() => {});
    api.get('/appointment-service-items').then((r) => setServices(r.data || [])).catch(() => {});
    load();
  }, []);

  const loadDoctors = async () => {
    try {
      const res = await api.get('/users/doctors');
      setDoctors(res.data || []);
    } catch {
      // sin listado de doctores el filtro queda vacío, no rompe la página
    }
  };

  useEffect(() => {
    if (clinic === 'all') setDoctors([]);
    else loadDoctors();
  }, [clinic]);

  const addDoctor = (id) => {
    if (id && !doctorFilter.some((d) => String(d) === String(id))) {
      setDoctorFilter([...doctorFilter, id]);
    }
  };

  const nameOfService = (sid) =>
    services.find((s) => String(s._id) === String(sid))?.name || 'Servicio';

  const toggleStatus = (s) =>
    setStatusFilter((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );

  const toggleDetalle = async (doctorId) => {
    const yaAbierto = expanded[doctorId];
    setExpanded((e) => ({ ...e, [doctorId]: !yaAbierto }));
    if (yaAbierto || detalles[doctorId]) return;
    setDetalles((prev) => ({ ...prev, [doctorId]: { loading: true } }));
    try {
      const res = await api.get('/commissions/doctor-appointments', {
        params: { ...filtrosActuales(), doctor: doctorId },
      });
      setDetalles((prev) => ({ ...prev, [doctorId]: { data: res.data } }));
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar el detalle');
      setDetalles((prev) => ({ ...prev, [doctorId]: { error: true } }));
    }
  };

  const columnas = useMemo(() => {
    const presentes = new Set();
    (data?.doctors || []).forEach((d) => {
      Object.entries(d.byStatus || {}).forEach(([k, v]) => {
        if (v > 0) presentes.add(k);
      });
    });
    return STATUS_OPTIONS.filter((s) => presentes.has(s.value));
  }, [data]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
        <HiOutlineCurrencyDollar className="text-emerald-600" /> Comisiones
      </h1>

      <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-sm">Desde<DateInput value={start} onChange={(e) => setStart(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" /></label>
          <label className="text-sm">Hasta<DateInput value={end} onChange={(e) => setEnd(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" /></label>
          <label className="text-sm">Sucursal
            <select
              value={clinic}
              onChange={(e) => setClinic(e.target.value)}
              className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm min-w-[180px]"
            >
              <option value="all">Todas las sucursales</option>
              {clinics.map((c) => (
                <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>
              ))}
            </select>
          </label>
          {clinic !== 'all' && (
            <label className="text-sm">Doctor
              <select
                value=""
                onChange={(e) => addDoctor(e.target.value)}
                className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm min-w-[200px]"
              >
                <option value="">Añadir doctor al filtro...</option>
                {doctors
                  .filter((d) => !doctorFilter.some((x) => String(x) === String(d._id)))
                  .map((d) => (
                    <option key={d._id} value={d._id}>{doctorOptionLabel(d)}</option>
                  ))}
              </select>
            </label>
          )}
          <label className="text-sm">Servicio
            <div className="mt-1">
              <ProductAutocomplete
                products={services}
                value=""
                onSelect={(p) => {
                  if (p && !serviceFilter.some((sid) => String(sid) === String(p._id))) {
                    setServiceFilter([...serviceFilter, p._id]);
                  }
                }}
                placeholder="Filtrar por servicio..."
              />
            </div>
          </label>
          <button
            onClick={load}
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm border-none cursor-pointer hover:bg-emerald-700"
          >
            Calcular
          </button>
        </div>

        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-xs text-slate-500">Estados:</span>
          {STATUS_OPTIONS.map((s) => (
            <button
              key={s.value}
              type="button"
              onClick={() => toggleStatus(s.value)}
              className={`px-2.5 py-1 rounded-full text-xs cursor-pointer border-none ${
                statusFilter.includes(s.value)
                  ? `${STATUS_COLORS[s.value]} font-semibold`
                  : 'bg-slate-50 text-slate-400 border border-slate-200'
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        {(doctorFilter.length > 0 || serviceFilter.length > 0 || statusFilter.length !== STATUS_OPTIONS.length) && (
          <div className="flex flex-wrap gap-1.5">
            {doctorFilter.map((id) => (
              <span key={id} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-slate-100 text-xs text-slate-700">
                {doctorOptionLabel(doctors.find((d) => String(d._id) === String(id)) || { name: 'Doctor', roleInClinic: '' })}
                <button
                  type="button"
                  onClick={() => setDoctorFilter(doctorFilter.filter((x) => String(x) !== String(id)))}
                  className="text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer leading-none"
                >
                  ✕
                </button>
              </span>
            ))}
            {serviceFilter.map((sid) => (
              <span key={sid} className="inline-flex items-center gap-1.5 pl-2 pr-1 py-1 rounded-full bg-slate-100 text-xs text-slate-700">
                {nameOfService(sid)}
                <button
                  type="button"
                  onClick={() => setServiceFilter(serviceFilter.filter((x) => String(x) !== String(sid)))}
                  className="text-slate-400 hover:text-slate-700 bg-transparent border-none cursor-pointer leading-none"
                >
                  ✕
                </button>
              </span>
            ))}
            <button
              onClick={() => { setDoctorFilter([]); setServiceFilter([]); setStatusFilter(['asistida', 'completada']); }}
              className="text-xs text-emerald-600 hover:underline bg-transparent border-none cursor-pointer px-1"
            >
              Limpiar filtros
            </button>
          </div>
        )}
      </div>

      {loading && <div className="text-slate-500">Cargando...</div>}

      {data && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            Total de citas en el filtro: <b>{data.totals?.total ?? 0}</b>
            {data.statuses && data.statuses.length > 0 && (
              <span className="text-slate-400"> · {data.statuses.join(', ')}</span>
            )}
          </p>

          <div className="space-y-3">
            {(data.doctors || []).map((d) => {
              const detalle = detalles[d.doctorId];
              const citas = detalle?.data?.appointments || [];
              const derivaciones = detalle?.data?.referralsByDoctor?.[d.doctorId] || [];
              return (
                <div key={d.doctorId} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-slate-50 border-b border-slate-100">
                    <div>
                      <span className="font-semibold text-slate-800">{d.name}</span>
                      {d.specialty ? (
                        <span className="ml-2 text-xs px-2 py-0.5 rounded bg-slate-200/70 text-slate-600">{d.specialty}</span>
                      ) : null}
                      {(d.clinics || []).length > 0 && (
                        <span className="block text-xs text-slate-500 mt-0.5">{d.clinics.join(', ')}</span>
                      )}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap justify-end">
                      <span className="text-sm text-slate-600 mr-1">
                        Total: <b className="text-slate-900">{d.total}</b>
                      </span>
                      {columnas.map((s) => (
                        <span
                          key={s.value}
                          title={`${s.label}: ${d.byStatus?.[s.value] || 0}`}
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs ${
                            (d.byStatus?.[s.value] || 0) > 0
                              ? `${STATUS_COLORS[s.value]} font-semibold`
                              : 'bg-white border border-slate-200 text-slate-300'
                          }`}
                        >
                          {s.label} {d.byStatus?.[s.value] || 0}
                        </span>
                      ))}
                    </div>
                  </div>
                  <div className="px-4 py-3 space-y-3">
                    {d.services && d.services.length > 0 ? (
                      <div>
                        <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide mb-2">
                          Servicios atendidos
                        </p>
                        <div className="flex flex-wrap gap-1.5 bg-emerald-50/40 border border-emerald-100 rounded-lg p-3">
                          {[...d.services].sort((a, b) => b.count - a.count).map((svc) => (
                            <span
                              key={svc.name}
                              title={Object.entries(svc.byStatus || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                              className="inline-flex items-center gap-1.5 bg-white border border-emerald-200 text-slate-700 text-xs px-2.5 py-1 rounded-full"
                            >
                              {svc.name}
                              <span className="bg-emerald-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{svc.count}</span>
                            </span>
                          ))}
                        </div>
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400">Sin servicios registrados en las citas de este doctor.</p>
                    )}

                    <div>
                      <button
                        type="button"
                        onClick={() => toggleDetalle(d.doctorId)}
                        className="inline-flex items-center gap-1 text-xs text-emerald-600 hover:underline bg-transparent border-none cursor-pointer"
                      >
                        <HiOutlineChevronDown
                          className={`w-3.5 h-3.5 transition-transform ${expanded[d.doctorId] ? 'rotate-180' : ''}`}
                        />
                        {expanded[d.doctorId] ? 'Ocultar citas' : `Ver citas (${d.total})`}
                      </button>
                    </div>

                    {expanded[d.doctorId] && (
                      <div className="space-y-3">
                        {detalle?.loading && <p className="text-xs text-slate-400">Cargando citas...</p>}
                        {detalle?.error && <p className="text-xs text-red-500">No se pudo cargar el detalle.</p>}
                        {citas.length > 0 && (
                          <div className="overflow-x-auto border border-slate-200 rounded-lg">
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
                                      {a.visitsTotal > 1 && (
                                        <span
                                          title={`Este doctor atendió ${a.visitsTotal} veces a este paciente en el filtro`}
                                          className="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 text-[10px] font-semibold"
                                        >
                                          visita {a.visitNumber}/{a.visitsTotal}
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-slate-600">{a.services?.join(', ') || '—'}</td>
                                    <td className="px-3 py-2">
                                      <span className={`px-2 py-0.5 rounded-full font-semibold ${STATUS_COLORS[a.status] || 'bg-slate-100 text-slate-600'}`}>
                                        {STATUS_OPTIONS.find((s) => s.value === a.status)?.label || a.status}
                                      </span>
                                    </td>
                                    <td className="px-3 py-2 text-slate-600">
                                      {fmtAtendientes(a) || '—'}
                                      {a.multiprofesional && (
                                        <span className="block text-[10px] text-amber-700 font-semibold mt-0.5">
                                          Atendida por {a.atendientes.filter((t) => t.kind === 'doctor').length} doctores
                                        </span>
                                      )}
                                    </td>
                                    <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{fmtPago(a)}</td>
                                    <td className="px-3 py-2">
                                      {(a.seguimientos || []).length > 0 ? (
                                        <div className="flex flex-wrap gap-1">
                                          {a.seguimientos.map((s, i) => (
                                            <span
                                              key={i}
                                              title={s.motivoConsulta || ''}
                                              className="inline-flex items-center gap-1 bg-violet-50 border border-violet-200 text-violet-700 px-1.5 py-0.5 rounded-full"
                                            >
                                              {s.sueros > 0 && <b>Suero ×{s.sueros}</b>}
                                              {(s.otros || []).slice(0, 3).map((n, j) => (
                                                <span key={j}>{n}</span>
                                              ))}
                                            </span>
                                          ))}
                                        </div>
                                      ) : (
                                        <span className="text-slate-300">—</span>
                                      )}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        )}
                        {!detalle?.loading && citas.length === 0 && !detalle?.error && (
                          <p className="text-xs text-slate-400">Sin citas que mostrar.</p>
                        )}

                        {derivaciones.length > 0 && (
                          <div>
                            <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide mb-2">
                              Derivaciones añadidas ({derivaciones.length})
                            </p>
                            <div className="flex flex-wrap gap-1.5 bg-violet-50/40 border border-violet-100 rounded-lg p-3">
                              {derivaciones.map((r) => (
                                <span
                                  key={r.id}
                                  title={r.reason || ''}
                                  className="inline-flex items-center gap-1.5 bg-white border border-violet-200 text-slate-700 text-xs px-2 py-1 rounded-full"
                                >
                                  {r.patient} → {r.toDoctor || r.specialty || '—'}
                                  <span className="text-[10px] text-slate-400">{fmtDate(r.date)}</span>
                                  <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full ${
                                    r.status === 'atendida' ? 'bg-emerald-100 text-emerald-700'
                                      : r.status === 'cancelada' ? 'bg-red-100 text-red-600'
                                      : 'bg-slate-100 text-slate-500'
                                  }`}>
                                    {r.status}
                                  </span>
                                </span>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {(!data.doctors || data.doctors.length === 0) && (
              <div className="bg-white rounded-xl border border-slate-200 px-4 py-6 text-center text-slate-400">
                Sin atenciones en el período con los filtros aplicados.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
