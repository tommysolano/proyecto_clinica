import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCurrencyDollar, HiOutlineMegaphone, HiOutlineUserGroup } from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import ProductAutocomplete from '../components/ProductAutocomplete';
import { doctorOptionLabel } from '../utils/roles';
import { STATUS_COLORS, STATUS_OPTIONS } from '../utils/commissionsFormat';

const today = () => new Date().toISOString().slice(0, 10);
const monthAgo = () => new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

export default function Commissions() {
  const [tab, setTab] = useState('doctores');
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
  const [dataCC, setDataCC] = useState(null);
  const [loading, setLoading] = useState(false);

  const filtrosBase = () => {
    const params = { start, end };
    if (clinic) params.clinic = clinic;
    return params;
  };

  const filtrosActuales = () => {
    const params = filtrosBase();
    if (doctorFilter.length) params.doctor = doctorFilter.join(',');
    if (statusFilter.length) params.status = statusFilter.join(',');
    if (serviceFilter.length) params.service = serviceFilter.join(',');
    return params;
  };

  const load = async () => {
    setLoading(true);
    try {
      const [resDoc, resCC] = await Promise.all([
        api.get('/commissions/doctor-summary', { params: filtrosActuales() }),
        api.get('/commissions/callcenter-summary', { params: filtrosBase() }),
      ]);
      setData(resDoc.data);
      setDataCC(resCC.data);
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

  const columnas = useMemo(() => {
    const presentes = new Set();
    (data?.doctors || []).forEach((d) => {
      Object.entries(d.byStatus || {}).forEach(([k, v]) => {
        if (v > 0) presentes.add(k);
      });
    });
    return STATUS_OPTIONS.filter((s) => presentes.has(s.value));
  }, [data]);

  const urlDetalle = (doctorId, doctorName) => {
    const params = new URLSearchParams();
    if (start) params.set('start', start);
    if (end) params.set('end', end);
    if (clinic) params.set('clinic', clinic);
    if (statusFilter.length) params.set('status', statusFilter.join(','));
    if (serviceFilter.length) params.set('service', serviceFilter.join(','));
    if (doctorName) params.set('name', doctorName);
    return `/commissions/${doctorId}?${params.toString()}`;
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineCurrencyDollar className="text-emerald-600" /> Comisiones
        </h1>
        <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
          <button
            type="button"
            onClick={() => setTab('doctores')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm cursor-pointer border-none ${
              tab === 'doctores' ? 'bg-white text-emerald-700 font-semibold shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <HiOutlineUserGroup className="w-4 h-4" /> Doctores
          </button>
          <button
            type="button"
            onClick={() => setTab('marketing')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm cursor-pointer border-none ${
              tab === 'marketing' ? 'bg-white text-emerald-700 font-semibold shadow-sm' : 'text-slate-500 hover:text-slate-700'
            }`}
          >
            <HiOutlineMegaphone className="w-4 h-4" /> Marketing
          </button>
        </div>
      </div>

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
          {tab === 'doctores' && clinic !== 'all' && (
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
          {tab === 'doctores' && (
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
          )}
          <button
            onClick={load}
            className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm border-none cursor-pointer hover:bg-emerald-700"
          >
            Calcular
          </button>
        </div>

        {tab === 'doctores' && (
          <>
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
          </>
        )}
      </div>

      {loading && <div className="text-slate-500">Cargando...</div>}

      {tab === 'doctores' && data && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            Total de citas en el filtro: <b>{data.totals?.total ?? 0}</b>
            {data.statuses && data.statuses.length > 0 && (
              <span className="text-slate-400"> · {data.statuses.join(', ')}</span>
            )}
          </p>

          <div className="space-y-3">
            {(data.doctors || []).map((d) => (
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
                    <a
                      href={urlDetalle(d.doctorId, d.name)}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs text-emerald-600 hover:underline"
                    >
                      Ver citas ({d.total})
                    </a>
                  </div>
                </div>
              </div>
            ))}
            {(!data.doctors || data.doctors.length === 0) && (
              <div className="bg-white rounded-xl border border-slate-200 px-4 py-6 text-center text-slate-400">
                Sin atenciones en el período con los filtros aplicados.
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'marketing' && dataCC && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            Citas agendadas por call center: <b>{dataCC.totals?.total ?? 0}</b>
            <span className="text-emerald-700"> · nuevos: {dataCC.totals?.nuevos ?? 0}</span>
            <span className="text-slate-400"> · recurrentes: {dataCC.totals?.recurrentes ?? 0}</span>
          </p>

          <div className="space-y-3">
            {(dataCC.agents || []).map((a) => (
              <div key={a.userId} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-slate-50 border-b border-slate-100">
                  <div>
                    <span className="font-semibold text-slate-800">{a.name}</span>
                    {(a.clinics || []).length > 0 && (
                      <span className="block text-xs text-slate-500 mt-0.5">{a.clinics.join(', ')}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <span className="text-sm text-slate-600 mr-1">
                      Agendadas: <b className="text-slate-900">{a.total}</b>
                    </span>
                    <span
                      title="Pacientes nuevos"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700 font-semibold"
                    >
                      Nuevos {a.nuevos}
                    </span>
                    <span
                      title="Pacientes recurrentes"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-slate-200/70 text-slate-700 font-semibold"
                    >
                      Recurrentes {a.recurrentes}
                    </span>
                  </div>
                </div>
              </div>
            ))}
            {(!dataCC.agents || dataCC.agents.length === 0) && (
              <div className="bg-white rounded-xl border border-slate-200 px-4 py-6 text-center text-slate-400">
                No hay agentes de call center (o no agendaron citas) en el período.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
