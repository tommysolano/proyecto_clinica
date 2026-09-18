import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCurrencyDollar } from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import ProductAutocomplete from '../components/ProductAutocomplete';
import { doctorOptionLabel } from '../utils/roles';

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

  const load = async () => {
    setLoading(true);
    try {
      const params = { start, end };
      if (clinic) params.clinic = clinic;
      if (doctorFilter.length) params.doctor = doctorFilter.join(',');
      if (statusFilter.length) params.status = statusFilter.join(',');
      if (serviceFilter.length) params.service = serviceFilter.join(',');
      const res = await api.get('/commissions/doctor-summary', { params });
      setData(res.data);
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

          <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-4 py-2">Doctor</th>
                  <th className="text-left px-4 py-2">Sucursales</th>
                  <th className="text-center px-4 py-2">Total citas</th>
                  {columnas.map((s) => (
                    <th key={s.value} className="text-center px-4 py-2">{s.label}</th>
                  ))}
                  <th className="text-left px-4 py-2">Servicios atendidos</th>
                </tr>
              </thead>
              <tbody>
                {(data.doctors || []).map((d) => (
                  <tr key={d.doctorId} className="border-t border-slate-100">
                    <td className="px-4 py-2 font-medium text-slate-800 whitespace-nowrap">
                      {d.name}
                      {d.specialty ? <span className="text-slate-400 text-xs ml-1">({d.specialty})</span> : null}
                    </td>
                    <td className="px-4 py-2 text-slate-500 text-xs">
                      {(d.clinics || []).join(', ') || '—'}
                    </td>
                    <td className="px-4 py-2 text-center font-bold text-slate-800">{d.total}</td>
                    {columnas.map((s) => (
                      <td key={s.value} className="px-4 py-2 text-center">
                        {(d.byStatus?.[s.value] || 0) > 0 ? (
                          <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[s.value]}`}>
                            {d.byStatus[s.value]}
                          </span>
                        ) : (
                          <span className="text-slate-300">0</span>
                        )}
                      </td>
                    ))}
                    <td className="px-4 py-2">
                      {d.services && d.services.length > 0 ? (
                        <div className="flex flex-wrap gap-1.5">
                          {d.services.map((svc) => (
                            <span
                              key={svc.name}
                              title={Object.entries(svc.byStatus || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                              className="inline-flex items-center gap-1.5 bg-slate-50 border border-slate-200 text-slate-700 text-xs px-2 py-0.5 rounded-full"
                            >
                              {svc.name}
                              <span className="bg-emerald-600 text-white text-[10px] font-bold px-1.5 rounded-full">{svc.count}</span>
                            </span>
                          ))}
                        </div>
                      ) : (
                        <span className="text-slate-300 text-xs">—</span>
                      )}
                    </td>
                  </tr>
                ))}
                {(!data.doctors || data.doctors.length === 0) && (
                  <tr>
                    <td colSpan={4 + columnas.length} className="px-4 py-6 text-center text-slate-400">
                      Sin atenciones en el período con los filtros aplicados.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
