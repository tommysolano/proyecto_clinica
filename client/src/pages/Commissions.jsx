import { useEffect, useMemo, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCurrencyDollar, HiOutlineMegaphone, HiOutlineUserGroup, HiOutlineDocumentArrowDown, HiOutlinePlusCircle } from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import Modal from '../components/Modal';
import NumericInput from '../components/NumericInput';
import ProductAutocomplete from '../components/ProductAutocomplete';
import { doctorOptionLabel, doctorTypeLabel } from '../utils/roles';
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
  const [commissionEditor, setCommissionEditor] = useState(null);
  const [commissionForm, setCommissionForm] = useState({ amountType: 'fixed', value: '' });
  const [savingCommission, setSavingCommission] = useState(false);
  const [adjustEditor, setAdjustEditor] = useState(null);
  const [adjustForm, setAdjustForm] = useState({ amount: '', note: '' });
  const [savingAdjust, setSavingAdjust] = useState(false);

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

  /**
   * LA PÁGINA SE ACTUALIZA SOLA. Cualquier cambio de filtro —fechas, sucursal,
   * doctores, estados o servicios— recalcula el resumen solo, con un cuarto de
   * segundo de respiro para no disparar una petición por cada tecla. El botón
   * «Calcular» queda para forzar el recálculo a mano.
   */
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, end, clinic, doctorFilter, statusFilter, serviceFilter, tab]);

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

  /** El DETALLE GENERAL: todas las citas de todos los doctores que cumplan los filtros (fechas, sucursal, estados y servicios). */
  const urlDetalleGeneral = () => urlDetalle('todos');

  const openCommissionEditor = (doctor, service) => {
    if (!service.serviceId) {
      toast.error('Este servicio antiguo no está vinculado al catálogo de Agenda');
      return;
    }
    const current = service.commission;
    setCommissionEditor({ scope: 'service', doctor, service, commission: current });
    setCommissionForm({
      amountType: !current?.mixed && current?.amountType ? current.amountType : 'fixed',
      value: !current?.mixed && current?.value != null ? String(current.value) : '',
    });
  };

  const openPatientCommissionEditor = (doctor) => {
    const current = doctor.patientCommission;
    setCommissionEditor({ scope: 'patient', doctor, service: null, commission: current });
    setCommissionForm({
      amountType: !current?.mixed && current?.amountType ? current.amountType : 'fixed',
      value: !current?.mixed && current?.value != null ? String(current.value) : '',
    });
  };

  const saveCommission = async (e) => {
    e.preventDefault();
    const value = Number(commissionForm.value);
    if (!Number.isFinite(value) || value < 0) return toast.error('Ingresa un valor válido');
    if (commissionForm.amountType === 'percent' && value > 100) return toast.error('El porcentaje no puede superar 100');
    setSavingCommission(true);
    try {
      await api.put(
        commissionEditor.scope === 'patient'
          ? '/commissions/doctor-patient-rule'
          : '/commissions/doctor-service-rule',
        {
        doctor: commissionEditor.doctor.doctorId,
        ...(commissionEditor.scope === 'service' ? { service: commissionEditor.service.serviceId } : {}),
        clinics: commissionEditor.scope === 'service'
          ? commissionEditor.service.clinicIds
          : commissionEditor.doctor.clinicIds,
        amountType: commissionForm.amountType,
        value,
        }
      );
      toast.success('Comisión guardada');
      setCommissionEditor(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar la comisión');
    } finally {
      setSavingCommission(false);
    }
  };

  const removeCommission = async () => {
    if (!commissionEditor?.commission) return;
    setSavingCommission(true);
    try {
      await api.put(
        commissionEditor.scope === 'patient'
          ? '/commissions/doctor-patient-rule'
          : '/commissions/doctor-service-rule',
        {
        doctor: commissionEditor.doctor.doctorId,
        ...(commissionEditor.scope === 'service' ? { service: commissionEditor.service.serviceId } : {}),
        clinics: commissionEditor.scope === 'service'
          ? commissionEditor.service.clinicIds
          : commissionEditor.doctor.clinicIds,
        active: false,
        }
      );
      toast.success('Comisión eliminada');
      setCommissionEditor(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar la comisión');
    } finally {
      setSavingCommission(false);
    }
  };

  const commissionLabel = (commission) => {
    if (!commission) return 'Definir comisión';
    if (commission.mixed) return `Valores distintos · ganado $${Number(commission.earned || 0).toFixed(2)}`;
    const label = commission.amountType === 'percent'
      ? `${Number(commission.value).toFixed(2)}%`
      : `$${Number(commission.value).toFixed(2)}`;
    const earned = `ganado $${Number(commission.earned || 0).toFixed(2)}`;
    return commission.partial ? `${label} (parcial) · ${earned}` : `${label} · ${earned}`;
  };

  const openAdjustEditor = (doctor) => {
    setAdjustEditor(doctor);
    setAdjustForm({ amount: '', note: '' });
  };

  const saveAdjust = async (e) => {
    e.preventDefault();
    const value = Number(adjustForm.amount);
    if (!Number.isFinite(value) || value === 0) return toast.error('Ingresa un valor distinto de cero');
    setSavingAdjust(true);
    try {
      await api.post('/commissions/doctor-adjustment', {
        doctor: adjustEditor.doctorId,
        amount: value,
        note: adjustForm.note,
        start,
        end,
      });
      toast.success('Ajuste agregado');
      setAdjustEditor(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar el ajuste');
    } finally {
      setSavingAdjust(false);
    }
  };

  const removeAdjust = async (doctor, adjId) => {
    if (!confirm('¿Eliminar este ajuste?')) return;
    try {
      await api.delete(`/commissions/doctor-adjustment/${adjId}`);
      toast.success('Ajuste eliminado');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar el ajuste');
    }
  };

  const downloadPdf = async (doctor) => {
    try {
      const params = filtrosActuales();
      params.doctor = doctor.doctorId;
      const res = await api.get('/commissions/doctor-report.pdf', { params, responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = `comisiones_${doctor.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()}_${start}_${end}.pdf`;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al generar el PDF');
    }
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
              <div className="mt-1">
                {/* CON BUSCADOR, igual que el filtro de servicio: se escribe y
                    el resultado se añade como chip. La especialidad va como
                    «categoría» para que el buscador la encuentre y las
                    sugerencias la muestren. Los doctores ya filtrados
                    desaparecen de las sugerencias. */}
                <ProductAutocomplete
                  products={doctors.map((d) => ({ ...d, category: d.specialty || '' }))}
                  value=""
                  onSelect={(p) => {
                    if (p && !doctorFilter.some((x) => String(x) === String(p._id))) {
                      setDoctorFilter([...doctorFilter, p._id]);
                    }
                  }}
                  placeholder="Filtrar por doctor..."
                />
              </div>
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
              <span className="text-slate-400"> — {data.statuses.join(', ')}</span>
            )}
            {/* EL DETALLE GENERAL: la misma información del detalle por doctor
                —fecha, paciente, servicios, estado, pago, seguimientos— pero de
                TODOS los doctores que cumplan los filtros. */}
            <a
              href={urlDetalleGeneral()}
              target="_blank"
              rel="noreferrer"
              className="ml-3 text-xs text-emerald-600 hover:underline"
            >
              Ver todas las citas
            </a>
          </p>

          <div className="space-y-3">
            {(data.doctors || []).map((d) => (
              <div key={d.doctorId} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-slate-50 border-b border-slate-100">
                  <div>
                    <span className="font-semibold text-slate-800">{d.name}</span>
                    {(d.roles?.length ? d.roles : [d.roleInClinic].filter(Boolean)).map((role) => (
                      <span key={role} className="ml-2 text-xs px-2 py-0.5 rounded bg-sky-100 text-sky-700 font-semibold">
                        {doctorTypeLabel({ roleInClinic: role })}
                      </span>
                    ))}
                    {d.specialty && !(d.roles?.length ? d.roles : [d.roleInClinic].filter(Boolean))
                      .some((role) => doctorTypeLabel({ roleInClinic: role }).toLowerCase() === d.specialty.trim().toLowerCase()) ? (
                      <span className="ml-2 text-xs px-2 py-0.5 rounded bg-slate-200/70 text-slate-600">
                        Especialidad: {d.specialty}
                      </span>
                    ) : null}
                    {(d.clinics || []).length > 0 && (
                      <span className="block text-xs text-slate-500 mt-0.5">{d.clinics.join(', ')}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <span className="text-sm text-slate-600 mr-1">
                      Total: <b className="text-slate-900">{d.total}</b>
                    </span>
                    <button
                      type="button"
                      onClick={() => openPatientCommissionEditor(d)}
                      title="Comisión base por cada paciente atendido, salvo cuando la cita ya paga por servicio"
                      className={`border-none rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
                        d.patientCommission
                          ? 'bg-violet-100 text-violet-700 hover:bg-violet-200'
                          : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-100'
                      }`}
                    >
                      Por paciente: {commissionLabel(d.patientCommission)}
                    </button>
                    {d.hasConfiguredCommissions && (
                      <span className="text-sm text-emerald-700 mr-1">
                        Ganado: <b>${Number(d.commissionTotal || 0).toFixed(2)}</b>
                      </span>
                    )}
                    {(d.adjustments || []).length > 0 && (
                      <span className="text-sm text-amber-700 mr-1">
                        Ajustes: <b>{d.adjustmentTotal >= 0 ? '+' : ''}${Number(d.adjustmentTotal || 0).toFixed(2)}</b>
                      </span>
                    )}
                    {((d.hasConfiguredCommissions && d.commissionTotal > 0) || d.adjustmentTotal > 0) && (
                      <span className="text-sm font-bold text-emerald-800 bg-emerald-100 rounded-full px-3 py-1 mr-1">
                        Total: ${Number(d.commissionTotalWithAdjustments || 0).toFixed(2)}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => downloadPdf(d)}
                      title="Descargar reporte PDF de comisiones del doctor (fecha, paciente, servicio y comisión)"
                      className="inline-flex items-center gap-1 border border-slate-200 bg-white text-slate-600 hover:bg-slate-100 hover:text-emerald-700 rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer"
                    >
                      <HiOutlineDocumentArrowDown className="w-3.5 h-3.5" /> PDF
                    </button>
                    <button
                      type="button"
                      onClick={() => openAdjustEditor(d)}
                      title="Sumar (o restar) un valor a las comisiones del doctor con una observación"
                      className="inline-flex items-center gap-1 border border-amber-200 bg-white text-amber-700 hover:bg-amber-50 rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer"
                    >
                      <HiOutlinePlusCircle className="w-3.5 h-3.5" /> Ajuste
                    </button>
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
                          <div
                            key={svc.name}
                            title={Object.entries(svc.byStatus || {}).map(([k, v]) => `${k}: ${v}`).join(' · ')}
                            className="inline-flex items-center gap-1.5 bg-white border border-emerald-200 text-slate-700 text-xs pl-2.5 pr-1 py-1 rounded-full"
                          >
                            <span>{svc.name}</span>
                            <span className="bg-emerald-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{svc.count}</span>
                            <button
                              type="button"
                              onClick={() => openCommissionEditor(d, svc)}
                              disabled={!svc.serviceId}
                              title={svc.serviceId ? 'Definir lo que gana el doctor por esta atención' : 'Servicio sin vínculo al catálogo de Agenda'}
                              className={`border-none rounded-full px-2 py-0.5 text-[10px] font-semibold ${
                                svc.serviceId
                                  ? svc.commission
                                    ? 'bg-sky-100 text-sky-700 hover:bg-sky-200 cursor-pointer'
                                    : 'bg-slate-100 text-slate-500 hover:bg-slate-200 cursor-pointer'
                                  : 'bg-slate-50 text-slate-300 cursor-not-allowed'
                              }`}
                            >
                              {commissionLabel(svc.commission)}
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-xs text-slate-400">Sin servicios registrados en las citas de este doctor.</p>
                  )}

                  {(d.adjustments || []).length > 0 && (
                    <div>
                      <p className="text-xs font-semibold text-amber-700 uppercase tracking-wide mb-2">
                        Ajustes manuales del período
                      </p>
                      <div className="space-y-1.5">
                        {d.adjustments.map((adj) => (
                          <div key={adj.id} className="flex items-center justify-between gap-3 bg-amber-50/60 border border-amber-200 rounded-lg px-3 py-2 text-xs">
                            <div className="min-w-0">
                              <span className={`font-bold ${adj.amount >= 0 ? 'text-emerald-700' : 'text-red-600'}`}>
                                {adj.amount >= 0 ? '+' : ''}${Number(adj.amount).toFixed(2)}
                              </span>
                              {adj.note && <span className="text-slate-600 ml-2">{adj.note}</span>}
                              <span className="block text-[10px] text-slate-400 mt-0.5">
                                {new Date(adj.start).toLocaleDateString()} — {new Date(adj.end).toLocaleDateString()}
                                {adj.createdBy ? ` · registrado por ${adj.createdBy}` : ''}
                              </span>
                            </div>
                            <button
                              type="button"
                              onClick={() => removeAdjust(d, adj.id)}
                              title="Eliminar ajuste"
                              className="text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer text-sm leading-none"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
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

      <Modal
        isOpen={!!commissionEditor}
        onClose={() => !savingCommission && setCommissionEditor(null)}
        title={commissionEditor?.scope === 'patient' ? 'Comisión por paciente atendido' : 'Comisión por servicio'}
        size="sm"
      >
        {commissionEditor && (
          <form onSubmit={saveCommission} className="space-y-4">
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2.5 text-sm">
              <div className="font-semibold text-slate-800">{commissionEditor.doctor.name}</div>
              <div className="text-slate-500">
                {commissionEditor.scope === 'patient' ? 'Cada paciente atendido' : commissionEditor.service.name}
              </div>
              {((commissionEditor.scope === 'patient' ? commissionEditor.doctor.clinicIds : commissionEditor.service.clinicIds) || []).length > 1 && (
                <div className="text-xs text-sky-700 mt-1">
                  Se aplicará en {(commissionEditor.scope === 'patient' ? commissionEditor.doctor.clinicIds : commissionEditor.service.clinicIds).length} sucursales del resultado.
                </div>
              )}
            </div>

            {commissionEditor.commission?.mixed && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                Actualmente existen valores distintos por sucursal. Al guardar se unificarán con este valor.
              </p>
            )}

            {commissionEditor.scope === 'patient' && (
              <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
                Esta comisión se paga una vez por cita completada. Si la cita tiene un servicio con comisión propia, se paga la del servicio y esta base no se suma.
              </p>
            )}

            <label className="block text-sm text-slate-700">Forma de cálculo
              <select
                value={commissionForm.amountType}
                onChange={(e) => setCommissionForm({ ...commissionForm, amountType: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2.5 bg-white"
              >
                <option value="fixed">Valor fijo por cita atendida</option>
                <option value="percent">Porcentaje del valor cobrado</option>
              </select>
            </label>

            <label className="block text-sm text-slate-700">
              {commissionForm.amountType === 'percent' ? 'Porcentaje (%)' : 'Valor fijo ($)'}
              <NumericInput
                value={commissionForm.value}
                onChange={(e) => setCommissionForm({ ...commissionForm, value: e.target.value })}
                min="0"
                max={commissionForm.amountType === 'percent' ? '100' : undefined}
                required
                placeholder={commissionForm.amountType === 'percent' ? 'Ej. 20' : 'Ej. 15.00'}
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2.5"
              />
              {commissionForm.amountType === 'percent' && (
                <span className="block mt-1 text-xs text-slate-400">
                  Se calcula sobre el valor total acordado de la cita. Un abono incluido en ese valor no se duplica.
                </span>
              )}
            </label>

            <div className="flex items-center justify-between gap-3 pt-1">
              <div>
                {commissionEditor.commission && (
                  <button
                    type="button"
                    onClick={removeCommission}
                    disabled={savingCommission}
                    className="px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-xl bg-transparent border-none cursor-pointer disabled:opacity-50"
                  >
                    Quitar comisión
                  </button>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setCommissionEditor(null)} disabled={savingCommission} className="px-3 py-2 text-sm border border-slate-200 rounded-xl bg-white cursor-pointer disabled:opacity-50">
                  Cancelar
                </button>
                <button disabled={savingCommission} className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-xl border-none cursor-pointer disabled:opacity-50">
                  {savingCommission ? 'Guardando...' : 'Guardar'}
                </button>
              </div>
            </div>
          </form>
        )}
      </Modal>

      <Modal
        isOpen={!!adjustEditor}
        onClose={() => !savingAdjust && setAdjustEditor(null)}
        title="Ajuste de comisiones"
        size="sm"
      >
        {adjustEditor && (
          <form onSubmit={saveAdjust} className="space-y-4">
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2.5 text-sm">
              <div className="font-semibold text-slate-800">{adjustEditor.name}</div>
              <div className="text-slate-500">
                Período: {start} — {end}
              </div>
              {adjustEditor.hasConfiguredCommissions && (
                <div className="text-xs text-emerald-700 mt-1">
                  Ganado en el sistema: ${Number(adjustEditor.commissionTotal || 0).toFixed(2)}
                </div>
              )}
            </div>

            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Este valor se suma al total de comisiones del doctor en el período (también admite un valor negativo para descontar). Úsalo cuando una comisión no se contabilizó correctamente en el sistema.
            </p>

            <label className="block text-sm text-slate-700">
              Valor a sumar ($)
              <NumericInput
                value={adjustForm.amount}
                onChange={(e) => setAdjustForm({ ...adjustForm, amount: e.target.value })}
                required
                placeholder="Ej. 25.00 (usa - para descontar)"
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2.5"
              />
            </label>

            <label className="block text-sm text-slate-700">
              Observación
              <textarea
                value={adjustForm.note}
                onChange={(e) => setAdjustForm({ ...adjustForm, note: e.target.value })}
                rows={3}
                placeholder="Motivo del ajuste (p. ej. comisión de la cita del 12/09 no registrada)"
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2.5 resize-y"
              />
            </label>

            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setAdjustEditor(null)} disabled={savingAdjust} className="px-3 py-2 text-sm border border-slate-200 rounded-xl bg-white cursor-pointer disabled:opacity-50">
                Cancelar
              </button>
              <button disabled={savingAdjust} className="px-4 py-2 text-sm bg-amber-600 text-white rounded-xl border-none cursor-pointer disabled:opacity-50">
                {savingAdjust ? 'Guardando...' : 'Agregar ajuste'}
              </button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
