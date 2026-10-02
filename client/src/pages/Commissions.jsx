import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlineCurrencyDollar, HiOutlineMegaphone, HiOutlineUserGroup, HiOutlineDocumentArrowDown,
  HiOutlinePlusCircle, HiOutlineCheckBadge, HiOutlineArrowsRightLeft,
  HiOutlineChatBubbleLeftRight, HiOutlineCalendarDays, HiOutlineHeart,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import Modal from '../components/Modal';
import Paginador from '../components/Paginador';
import NumericInput from '../components/NumericInput';
import ProductAutocomplete from '../components/ProductAutocomplete';
import { doctorOptionLabel, doctorTypeLabel } from '../utils/roles';
import { fmtDate, fmtDateTime, todayEc } from '../utils/date';
import { useAuth } from '../context/AuthContext';
import {
  STATUS_COLORS, STATUS_OPTIONS, money, doctorRolesLabel, doctorSearchOption, statusLabel,
} from '../utils/commissionsFormat';

const today = () => todayEc();
const monthAgo = () => {
  const [y, m, d] = todayEc().split('-').map(Number);
  const f = new Date(y, m - 1, d - 30);
  return `${f.getFullYear()}-${String(f.getMonth() + 1).padStart(2, '0')}-${String(f.getDate()).padStart(2, '0')}`;
};

const RULE_ENDPOINT = {
  service: '/commissions/doctor-service-rule',
  patient: '/commissions/doctor-patient-rule',
  referral: '/commissions/doctor-referral-rule',
};

/** Una cifra del doctor: etiqueta arriba, valor grande, explicación al pasar el ratón. */
function Stat({ label, value, hint, tone = 'slate' }) {
  const tones = {
    slate: 'bg-white border-slate-200 text-slate-800',
    sky: 'bg-sky-50 border-sky-200 text-sky-800',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    teal: 'bg-teal-50 border-teal-200 text-teal-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
  };
  return (
    <div title={hint} className={`rounded-xl border px-3 py-2 min-w-0 ${tones[tone]}`}>
      <div className="text-[10px] uppercase tracking-wide opacity-70 font-semibold leading-tight">{label}</div>
      <div className="text-base font-bold tabular-nums mt-0.5">{value}</div>
    </div>
  );
}

export default function Commissions() {
  /**
   * MARKETING ENTRA SOLO AL APARTADO DE MARKETING (sep-2026). Los doctores
   * —tarifas, pagos, ajustes— siguen siendo del super-admin: para marketing no
   * hay pestañas, ni se piden los datos de doctores (el servidor se los niega).
   */
  const { user } = useAuth();
  const isSuper = !!user?.isSuperAdmin;
  const [tab, setTab] = useState(isSuper ? 'doctores' : 'marketing');
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
  // Apartado marketing: por qué fecha se filtra (la de la cita o el día en que
  // se agendó), el agente elegido y el listado de pacientes nuevos.
  const [fechaCC, setFechaCC] = useState('cita');
  const [agentCC, setAgentCC] = useState('');
  const [nuevosCC, setNuevosCC] = useState(null);
  // Pacientes nuevos de 200 en 200 (el servidor pagina).
  const [pageNuevos, setPageNuevos] = useState(1);
  const [loadingNuevos, setLoadingNuevos] = useState(false);
  const [loading, setLoading] = useState(false);
  const [commissionEditor, setCommissionEditor] = useState(null);
  const [commissionForm, setCommissionForm] = useState({ amountType: 'fixed', value: '', firstTimeOnly: false, timeBands: [] });
  const [savingCommission, setSavingCommission] = useState(false);
  const [adjustEditor, setAdjustEditor] = useState(null);
  const [adjustForm, setAdjustForm] = useState({ amount: '', note: '' });
  const [savingAdjust, setSavingAdjust] = useState(false);
  // Pago por período de UN doctor: { start, end, note, doctorId, name, doctor }
  const [payout, setPayout] = useState(null);
  const [payoutPreview, setPayoutPreview] = useState(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [savingPayout, setSavingPayout] = useState(false);

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

  const filtrosCC = () => ({ ...filtrosBase(), fecha: fechaCC });

  const load = async () => {
    setLoading(true);
    try {
      const [resDoc, resCC] = await Promise.all([
        isSuper ? api.get('/commissions/doctor-summary', { params: filtrosActuales() }) : null,
        api.get('/commissions/callcenter-summary', { params: filtrosCC() }),
      ]);
      if (resDoc) setData(resDoc.data);
      setDataCC(resCC.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar el resumen');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.get('/clinics').then((r) => setClinics(r.data || [])).catch(() => {});
    // Con `all`: el filtro y los nombres tienen que alcanzar también las citas
    // viejas, con servicios del catálogo anterior al inventario (oct-2026).
    if (isSuper) api.get('/appointment-service-items', { params: { all: 1 } }).then((r) => setServices(r.data || [])).catch(() => {});
  }, [isSuper]);

  /**
   * Doctores del filtro: los de la sucursal elegida o los de TODAS, cada uno con
   * su rol (general o especialidad). Antes el filtro solo salía con una
   * sucursal concreta y listaba los de la sucursal activa de la sesión.
   */
  useEffect(() => {
    if (!isSuper) return;
    api.get('/commissions/doctors', { params: { clinic } })
      .then((r) => setDoctors(r.data || []))
      .catch(() => setDoctors([]));
  }, [clinic, isSuper]);

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
  }, [start, end, clinic, doctorFilter, statusFilter, serviceFilter, tab, fechaCC]);

  /**
   * Pacientes nuevos del call center: se piden al entrar al apartado y cada vez
   * que cambia un filtro o el agente elegido.
   */
  useEffect(() => {
    if (tab !== 'marketing') return undefined;
    let vivo = true;
    const t = setTimeout(async () => {
      setLoadingNuevos(true);
      try {
        const r = await api.get('/commissions/callcenter-new-patients', {
          params: { ...filtrosCC(), ...(agentCC ? { agent: agentCC } : {}), page: pageNuevos, limit: 200 },
        });
        if (vivo) setNuevosCC(r.data);
      } catch (err) {
        if (vivo) toast.error(err.response?.data?.message || 'Error al cargar los pacientes nuevos');
      } finally {
        if (vivo) setLoadingNuevos(false);
      }
    }, 250);
    return () => { vivo = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, start, end, clinic, fechaCC, agentCC, pageNuevos]);

  // Cualquier cambio de filtro vuelve a la primera página.
  useEffect(() => { setPageNuevos(1); }, [start, end, clinic, fechaCC, agentCC]);

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
    if (doctorId === 'todos' && doctorFilter.length) params.set('doctor', doctorFilter.join(','));
    if (doctorName) params.set('name', doctorName);
    return `/commissions/${doctorId}?${params.toString()}`;
  };

  /** El DETALLE GENERAL: todas las citas de todos los doctores que cumplan los filtros. */
  const urlDetalleGeneral = () => urlDetalle('todos');

  // ─── Editor de tarifas (servicio, paciente, derivación) ───
  const openEditor = (scope, doctor, service = null) => {
    if (service && !service.serviceId) {
      toast.error('Este servicio antiguo no está vinculado al catálogo de Agenda');
      return;
    }
    const current = scope === 'patient'
      ? doctor.patientCommission
      : scope === 'referral' && !service ? doctor.referralCommission
      : service?.commission;
    setCommissionEditor({ scope, doctor, service, commission: current });
    setCommissionForm({
      amountType: !current?.mixed && current?.amountType ? current.amountType : 'fixed',
      value: !current?.mixed && current?.value != null ? String(current.value) : '',
      firstTimeOnly: !!current?.firstTimeOnly,
      timeBands: !current?.mixed
        ? (current?.timeBands || []).map((b) => ({ ...b, value: String(b.value) }))
        : [],
    });
  };

  // Tarifas por horario del editor: filas { startTime, endTime, amountType, value }.
  const setBand = (i, patch) => setCommissionForm((f) => ({
    ...f,
    timeBands: f.timeBands.map((b, j) => (j === i ? { ...b, ...patch } : b)),
  }));
  const addBand = () => setCommissionForm((f) => {
    const last = f.timeBands[f.timeBands.length - 1];
    // Propone el tramo siguiente: primero la mañana, luego desde donde acabó el anterior.
    const startTime = last?.endTime || '07:00';
    const endTime = last ? '20:00' : '13:00';
    return {
      ...f,
      timeBands: [...f.timeBands, { startTime, endTime, amountType: f.amountType, value: '' }],
    };
  });
  const removeBand = (i) => setCommissionForm((f) => ({ ...f, timeBands: f.timeBands.filter((_, j) => j !== i) }));

  const editorClinics = (ed) => {
    if (ed.service) return ed.service.clinicIds;
    if (ed.scope === 'referral') return ed.doctor.referralClinicIds?.length ? ed.doctor.referralClinicIds : ed.doctor.clinicIds;
    return ed.doctor.clinicIds;
  };

  const putRule = (body) => api.put(RULE_ENDPOINT[commissionEditor.scope], {
    doctor: commissionEditor.doctor.doctorId,
    ...(commissionEditor.service ? { service: commissionEditor.service.serviceId } : {}),
    clinics: editorClinics(commissionEditor),
    ...body,
  });

  const saveCommission = async (e) => {
    e.preventDefault();
    const value = Number(commissionForm.value);
    if (!Number.isFinite(value) || value < 0) return toast.error('Ingresa un valor válido');
    if (commissionForm.amountType === 'percent' && value > 100) return toast.error('El porcentaje no puede superar 100');
    const timeBands = commissionForm.timeBands.map((b) => ({ ...b, value: Number(b.value) }));
    for (const b of timeBands) {
      if (!b.startTime || !b.endTime) return toast.error('Cada horario necesita hora de inicio y de fin');
      if (b.startTime >= b.endTime) return toast.error(`El horario ${b.startTime}–${b.endTime} termina antes de empezar`);
      if (!Number.isFinite(b.value) || b.value < 0 || (b.amountType === 'percent' && b.value > 100)) {
        return toast.error(`Revisa el valor del horario ${b.startTime}–${b.endTime}`);
      }
    }
    setSavingCommission(true);
    try {
      await putRule({
        amountType: commissionForm.amountType,
        value,
        timeBands,
        ...(commissionEditor.scope === 'service' ? { firstTimeOnly: commissionForm.firstTimeOnly } : {}),
      });
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
      await putRule({ active: false });
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
    const ganado = `ganó ${money(commission.earned)}`;
    if (commission.mixed) return `Valores distintos · ${ganado}`;
    const label = commission.amountType === 'percent'
      ? `${Number(commission.value).toFixed(2)}%`
      : money(commission.value);
    const primera = commission.firstTimeOnly ? ' · solo 1ª vez' : '';
    const n = commission.timeBands?.length || 0;
    const horarios = n ? ` · ${n} horario${n > 1 ? 's' : ''}` : '';
    return `${label}${horarios}${primera}${commission.partial ? ' (parcial)' : ''} · ${ganado}`;
  };

  // ─── Ajustes ───
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

  const removeAdjust = async (adjId) => {
    if (!confirm('¿Eliminar este ajuste?')) return;
    try {
      await api.delete(`/commissions/doctor-adjustment/${adjId}`);
      toast.success('Ajuste eliminado');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar el ajuste');
    }
  };

  // ─── Pago por período, DE UN DOCTOR ───
  // Se paga doctor por doctor, desde su tarjeta: cada uno puede cobrar en
  // fechas distintas.
  const openPayout = (doctor) => {
    setPayoutPreview(null);
    setPayout({ start, end, note: '', doctorId: doctor.doctorId, name: doctor.name, doctor });
  };

  /**
   * Lo pendiente del doctor en el PERÍODO DEL PAGO (que puede no ser el del
   * filtro de la pantalla: p. ej. la pantalla enseña el mes y se paga la primera
   * quincena). Sin filtros de estado ni servicio: se paga todo lo devengado.
   */
  useEffect(() => {
    if (!payout?.start || !payout?.end || !payout?.doctorId) return undefined;
    const t = setTimeout(async () => {
      setLoadingPreview(true);
      try {
        const r = await api.get('/commissions/doctor-summary', {
          params: { start: payout.start, end: payout.end, clinic, doctor: payout.doctorId },
        });
        setPayoutPreview((r.data?.doctors || []).find((d) => d.doctorId === payout.doctorId) || null);
      } catch {
        setPayoutPreview(null);
      } finally {
        setLoadingPreview(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [payout?.start, payout?.end, payout?.doctorId, clinic]);

  const payoutTotal = Number(payoutPreview?.pendingTotal || 0);

  const savePayout = async (e) => {
    e.preventDefault();
    setSavingPayout(true);
    try {
      const r = await api.post('/commissions/payouts', {
        start: payout.start,
        end: payout.end,
        clinic,
        doctors: [payout.doctorId],
        note: payout.note,
      });
      const creado = r.data?.created?.[0];
      toast.success(`Pago registrado: ${payout.name}, ${money(creado?.amount)}`);
      setPayout(null);
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al registrar el pago');
    } finally {
      setSavingPayout(false);
    }
  };

  const removePayout = async (p) => {
    if (!confirm(`¿Deshacer el pago del ${fmtDate(p.start)} al ${fmtDate(p.end)}? Sus comisiones vuelven a «Por pagar».`)) return;
    try {
      await api.delete(`/commissions/payouts/${p.id}`);
      toast.success('Pago eliminado');
      await load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar el pago');
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

  // Botones «Ir a» de la lista de pacientes nuevos (chat, cita, seguimientos).
  const irA = 'inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs border border-slate-200 bg-white text-slate-600 hover:text-emerald-700 hover:border-emerald-300 no-underline whitespace-nowrap';

  const chipBtn = (active, extra = '') => `border-none rounded-full px-2 py-0.5 text-[10px] font-semibold cursor-pointer ${
    active ? 'bg-sky-100 text-sky-700 hover:bg-sky-200' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'
  } ${extra}`;

  const editorTitle = !commissionEditor ? '' : commissionEditor.scope === 'patient'
    ? 'Comisión por paciente atendido'
    : commissionEditor.scope === 'referral' ? 'Comisión por derivación realizada' : 'Comisión por servicio';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineCurrencyDollar className="text-emerald-600" /> Comisiones
        </h1>
        {isSuper && (
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
        )}
      </div>

      <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-3">
        <div className="flex flex-wrap gap-3 items-end">
          <label className="text-sm">Desde<DateInput value={start} onChange={(e) => setStart(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" /></label>
          <label className="text-sm">Hasta<DateInput value={end} onChange={(e) => setEnd(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" /></label>
          <label className="text-sm">Sucursal
            <select
              value={clinic}
              onChange={(e) => { setClinic(e.target.value); setDoctorFilter([]); }}
              className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm min-w-[180px]"
            >
              <option value="all">Todas las sucursales</option>
              {clinics.map((c) => (
                <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>
              ))}
            </select>
          </label>
          {tab === 'marketing' && (
            <label className="text-sm">Filtrar por
              <select
                value={fechaCC}
                onChange={(e) => setFechaCC(e.target.value)}
                className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm"
              >
                <option value="cita">Fecha de la cita</option>
                <option value="agendada">Fecha en que se agendó</option>
              </select>
            </label>
          )}
          {tab === 'doctores' && (
            <label className="text-sm">Doctor
              <div className="mt-1 min-w-[240px]">
                {/* CON BUSCADOR: se escribe el nombre o el rol («gineco»,
                    «general») y el resultado se añade como chip. Debajo de cada
                    nombre va su rol, general o especialidad. */}
                <ProductAutocomplete
                  products={doctors
                    .filter((d) => !doctorFilter.some((x) => String(x) === String(d._id)))
                    .map(doctorSearchOption)}
                  value=""
                  onSelect={(p) => {
                    if (p && !doctorFilter.some((x) => String(x) === String(p._id))) {
                      setDoctorFilter([...doctorFilter, p._id]);
                    }
                  }}
                  placeholder="Escribe un doctor o especialidad..."
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

            {(doctorFilter.length > 0 || serviceFilter.length > 0 || statusFilter.length !== 2) && (
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
          {/* Totales del filtro: lo que pagaron los pacientes y lo que se debe a los doctores. */}
          <div className="bg-white rounded-xl border border-slate-200 p-3 space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              <Stat label="Citas en el filtro" value={data.totals?.total ?? 0} />
              <Stat
                label="Generado"
                tone="sky"
                value={money(data.totals?.generated)}
                hint="Lo que pagaron los pacientes por las citas atendidas (asistidas/completadas) en el filtro"
              />
              <Stat
                label="Comisiones ganadas"
                tone="emerald"
                value={money(data.totals?.commissions)}
                hint="Lo que ganaron los doctores: servicios, paciente atendido, derivaciones realizadas y ajustes"
              />
              <Stat label="Ya pagado" tone="teal" value={money(data.totals?.paid)} hint="Comisiones que caen dentro de un pago registrado" />
              <Stat label="Por pagar" tone="amber" value={money(data.totals?.pending)} hint="Comisiones ganadas que aún no se han pagado" />
            </div>
            <p className="text-xs text-slate-500">
              {data.statuses && data.statuses.length > 0 && <>Estados: {data.statuses.join(', ')} · </>}
              {/* EL DETALLE GENERAL: la misma información del detalle por doctor
                  —fecha, paciente, servicios, estado, pago, seguimientos y
                  derivaciones— pero de TODOS los doctores que cumplan los filtros. */}
              <a href={urlDetalleGeneral()} target="_blank" rel="noreferrer" className="text-emerald-600 hover:underline font-semibold">
                Ver todas las citas y derivaciones
              </a>
            </p>
          </div>

          <div className="space-y-3">
            {(data.doctors || []).map((d) => {
              const ref = d.referrals || {};
              return (
                <div key={d.doctorId} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <div className="px-4 py-3 bg-slate-50 border-b border-slate-100 space-y-3">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
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
                        <button
                          type="button"
                          onClick={() => downloadPdf(d)}
                          title="Descargar reporte PDF de comisiones del doctor (fecha, paciente, concepto, comisión y si está pagada)"
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
                        <button
                          type="button"
                          onClick={() => openPayout(d)}
                          disabled={!(d.pendingTotal > 0)}
                          title="Marcar como pagadas las comisiones de este doctor en un período"
                          className="inline-flex items-center gap-1 border-none bg-teal-600 text-white hover:bg-teal-700 rounded-full px-3 py-1 text-[11px] font-semibold cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                        >
                          <HiOutlineCheckBadge className="w-3.5 h-3.5" /> Marcar como pagado
                        </button>
                      </div>
                    </div>

                    {/* LAS CIFRAS DEL DOCTOR, con nombre claro: cuánto pagaron sus
                        pacientes y cuánto ganó él, cuánto ya se le pagó y cuánto falta. */}
                    <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                      <Stat label="Citas" value={d.total} hint="Citas del doctor en el filtro" />
                      <Stat
                        label="Generado (pacientes)"
                        tone="sky"
                        value={money(d.generated)}
                        hint="Lo que pagaron los pacientes por las citas que atendió este doctor"
                      />
                      <Stat
                        label="Comisión ganada"
                        tone="emerald"
                        value={money(d.commissionTotalWithAdjustments)}
                        hint={`Servicios, paciente atendido y derivaciones: ${money(d.commissionTotal)}${d.adjustments?.length ? ` · ajustes ${d.adjustmentTotal >= 0 ? '+' : ''}${money(d.adjustmentTotal)}` : ''}`}
                      />
                      <Stat label="Ya pagado" tone="teal" value={money(d.paidTotal)} />
                      <Stat label="Por pagar" tone="amber" value={money(d.pendingTotal)} />
                    </div>
                    {!d.hasConfiguredCommissions && (
                      <p className="text-[11px] text-slate-400">
                        Sin comisiones configuradas: define abajo lo que gana por servicio, por paciente o por derivación.
                      </p>
                    )}
                  </div>

                  <div className="px-4 py-3 space-y-4">
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">
                          Servicios atendidos
                        </p>
                        <button
                          type="button"
                          onClick={() => openEditor('patient', d)}
                          title="Comisión base por cada paciente atendido, salvo cuando la cita ya paga por servicio"
                          className={`border-none rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
                            d.patientCommission
                              ? 'bg-violet-100 text-violet-700 hover:bg-violet-200'
                              : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          Por paciente: {commissionLabel(d.patientCommission)}
                        </button>
                      </div>
                      {d.services && d.services.length > 0 ? (
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
                                onClick={() => openEditor('service', d, svc)}
                                disabled={!svc.serviceId}
                                title={svc.serviceId
                                  ? `Definir lo que gana el doctor por esta atención${svc.commission?.repeated ? ` · ${svc.commission.repeated} cita(s) sin comisión: el paciente ya lo había recibido` : ''}`
                                  : 'Servicio sin vínculo al catálogo de Agenda'}
                                className={svc.serviceId
                                  ? chipBtn(!!svc.commission)
                                  : 'border-none rounded-full px-2 py-0.5 text-[10px] font-semibold bg-slate-50 text-slate-300 cursor-not-allowed'}
                              >
                                {commissionLabel(svc.commission)}
                              </button>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="text-xs text-slate-400">Sin servicios registrados en las citas de este doctor.</p>
                      )}
                    </div>

                    {/* DERIVACIONES: el doctor gana solo cuando el paciente SE HACE
                        la derivación. Las indicadas que no se realizaron no pagan. */}
                    <div>
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <p className="text-xs font-semibold text-violet-700 uppercase tracking-wide inline-flex items-center gap-1">
                          <HiOutlineArrowsRightLeft className="w-3.5 h-3.5" /> Derivaciones
                        </p>
                        <button
                          type="button"
                          onClick={() => openEditor('referral', d)}
                          title="Lo que gana el doctor por cada derivación que el paciente SE REALIZA (si el servicio derivado no tiene una tarifa propia)"
                          className={`border-none rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
                            d.referralCommission
                              ? 'bg-violet-100 text-violet-700 hover:bg-violet-200'
                              : 'bg-white text-slate-500 border border-slate-200 hover:bg-slate-100'
                          }`}
                        >
                          Por derivación realizada: {commissionLabel(d.referralCommission)}
                        </button>
                      </div>
                      <p className="text-xs text-slate-600 mb-2">
                        Indicadas en el período: <b>{ref.indicadas || 0}</b>
                        <span className="text-emerald-700"> · realizadas {ref.realizadas || 0}</span>
                        <span className="text-blue-700"> · agendadas {ref.agendadas || 0}</span>
                        <span className="text-amber-700"> · sin realizar {(ref.sinAgendar || 0) + (ref.noRealizadas || 0)}</span>
                        <span className="text-slate-400"> — realizadas en el período (pagan): {ref.realizadasEnPeriodo || 0} · comisión {money(ref.earned)}</span>
                      </p>
                      {(d.referralServices || []).length > 0 && (
                        <div className="flex flex-wrap gap-1.5 bg-violet-50/40 border border-violet-100 rounded-lg p-3">
                          {d.referralServices.map((svc) => (
                            <div
                              key={svc.name}
                              className="inline-flex items-center gap-1.5 bg-white border border-violet-200 text-slate-700 text-xs pl-2.5 pr-1 py-1 rounded-full"
                            >
                              <span>{svc.name}</span>
                              <span title="Derivaciones realizadas en el período" className="bg-violet-600 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full">{svc.realizadas}</span>
                              <button
                                type="button"
                                onClick={() => openEditor('referral', d, svc)}
                                disabled={!svc.serviceId}
                                title="Tarifa propia por derivar a este servicio (reemplaza a la base de derivación)"
                                className={svc.serviceId
                                  ? chipBtn(!!svc.commission)
                                  : 'border-none rounded-full px-2 py-0.5 text-[10px] font-semibold bg-slate-50 text-slate-300 cursor-not-allowed'}
                              >
                                {svc.commission ? commissionLabel(svc.commission) : 'Usa la base'}
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>

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
                                  {adj.amount >= 0 ? '+' : ''}{money(adj.amount)}
                                </span>
                                {adj.note && <span className="text-slate-600 ml-2">{adj.note}</span>}
                                {adj.pagado && <span className="ml-2 px-1.5 py-0.5 rounded bg-teal-100 text-teal-700 font-semibold text-[10px]">Pagado</span>}
                                <span className="block text-[10px] text-slate-400 mt-0.5">
                                  {fmtDate(adj.start)} — {fmtDate(adj.end)}
                                  {adj.createdBy ? ` · registrado por ${adj.createdBy}` : ''}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => removeAdjust(adj.id)}
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

                    {(d.payouts || []).length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-teal-700 uppercase tracking-wide mb-2">
                          Pagos registrados
                        </p>
                        <div className="space-y-1.5">
                          {d.payouts.map((p) => (
                            <div key={p.id} className="flex items-center justify-between gap-3 bg-teal-50/60 border border-teal-200 rounded-lg px-3 py-2 text-xs">
                              <div className="min-w-0">
                                <span className="font-bold text-teal-800">{money(p.amount)}</span>
                                <span className="text-slate-700 ml-2">del {fmtDate(p.start)} al {fmtDate(p.end)}</span>
                                {!p.allClinics && <span className="text-slate-400 ml-1">(una sucursal)</span>}
                                {p.note && <span className="text-slate-500 ml-2">· {p.note}</span>}
                                <span className="block text-[10px] text-slate-400 mt-0.5">
                                  {p.count} comisión(es){p.createdBy ? ` · registrado por ${p.createdBy}` : ''}{p.createdAt ? ` el ${fmtDate(p.createdAt)}` : ''}
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => removePayout(p)}
                                title="Deshacer este pago"
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
                        Ver citas y derivaciones ({d.total})
                      </a>
                    </div>
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

      {tab === 'marketing' && dataCC && (
        <div className="space-y-3">
          <p className="text-sm text-slate-500">
            Citas agendadas por call center: <b>{dataCC.totals?.total ?? 0}</b>
            <span className="text-emerald-700"> · nuevos: {dataCC.totals?.nuevos ?? 0}</span>
            <span className="text-amber-700"> · nuevos sin asistir: {dataCC.totals?.nuevosSinAsistir ?? 0}</span>
            <span className="text-slate-400"> · recurrentes: {dataCC.totals?.recurrentes ?? 0}</span>
            <span className="text-slate-400">
              {' '}· por {fechaCC === 'agendada' ? 'fecha en que se agendó' : 'fecha de la cita'}
            </span>
          </p>

          <div className="space-y-3">
            {(dataCC.agents || []).map((a) => (
              <div
                key={a.userId}
                className={`bg-white rounded-xl border overflow-hidden ${
                  agentCC === a.userId ? 'border-emerald-400 ring-2 ring-emerald-100' : 'border-slate-200'
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 bg-slate-50 border-b border-slate-100">
                  <div>
                    <span className="font-semibold text-slate-800">{a.name}</span>
                    {/* Desactivado: su cuenta está cerrada, pero lo que agendó
                        sigue contando para calcular lo que se le debe. */}
                    {a.inactive && (
                      <span
                        title="Cuenta desactivada. Sus agendamientos siguen contando para la comisión."
                        className="ml-2 inline-flex px-2 py-0.5 rounded-full text-[10px] font-semibold bg-rose-100 text-rose-700 align-middle"
                      >
                        Desactivado
                      </span>
                    )}
                    {(a.clinics || []).length > 0 && (
                      <span className="block text-xs text-slate-500 mt-0.5">{a.clinics.join(', ')}</span>
                    )}
                  </div>
                  <div className="flex items-center gap-2 flex-wrap justify-end">
                    <span className="text-sm text-slate-600 mr-1">
                      Agendadas: <b className="text-slate-900">{a.total}</b>
                    </span>
                    <span
                      title="Pacientes nuevos cuya primera cita quedó asistida o completada"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-emerald-100 text-emerald-700 font-semibold"
                    >
                      Nuevos {a.nuevos}
                    </span>
                    {a.nuevosSinAsistir > 0 && (
                      <span
                        title="Paciente nuevo que todavía no ha asistido a ninguna cita (pendiente, no asistió o cancelada): no cuenta como nuevo hasta que asista"
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-700 font-semibold"
                      >
                        Sin asistir {a.nuevosSinAsistir}
                      </span>
                    )}
                    <span
                      title="Pacientes recurrentes"
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-slate-200/70 text-slate-700 font-semibold"
                    >
                      Recurrentes {a.recurrentes}
                    </span>
                    {a.nuevos > 0 && (
                      <button
                        type="button"
                        onClick={() => setAgentCC(agentCC === a.userId ? '' : a.userId)}
                        className="px-2.5 py-1 rounded-lg text-xs border border-emerald-200 bg-white text-emerald-700 hover:bg-emerald-50 cursor-pointer"
                      >
                        {agentCC === a.userId ? 'Ver todos' : 'Ver sus nuevos'}
                      </button>
                    )}
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

          {/* PACIENTES NUEVOS, UNO POR UNO: quién, quién lo agendó, cuándo se
              agendó y cuándo cuenta como nuevo (cuando asistió a esa primera cita). */}
          <div id="nuevos-cc" className="bg-white rounded-xl border border-slate-200 p-3 space-y-3 scroll-mt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-slate-800 m-0">
                  Pacientes nuevos agendados por call center
                  {nuevosCC && <span className="text-slate-400 font-normal"> ({nuevosCC.total})</span>}
                </h2>
                <p className="text-xs text-slate-500 m-0 mt-0.5">
                  Cuenta como nuevo el paciente en su primera cita atendida (asistida o completada);
                  si faltó y se le agendó otra cita, cuenta la nueva cuando asiste. No cuenta quien ya
                  tenía un seguimiento anterior a la cita o ficha física escaneada.
                </p>
              </div>
              {agentCC && (
                <button
                  type="button"
                  onClick={() => setAgentCC('')}
                  className="inline-flex items-center gap-1.5 pl-2 pr-1.5 py-1 rounded-full bg-slate-100 text-xs text-slate-700 border-none cursor-pointer"
                >
                  {(dataCC.agents || []).find((x) => x.userId === agentCC)?.name || 'Agente'} ✕
                </button>
              )}
            </div>

            {loadingNuevos && !nuevosCC && <div className="text-sm text-slate-500">Cargando...</div>}
            {nuevosCC && nuevosCC.patients.length === 0 && (
              <div className="px-4 py-6 text-center text-slate-400 text-sm">
                No hay pacientes nuevos agendados por call center en el período.
              </div>
            )}
            {nuevosCC && (
              <Paginador pagination={nuevosCC.pagination} onPage={setPageNuevos} unidad="pacientes" />
            )}
            {nuevosCC && nuevosCC.patients.length > 0 && (
              <div className="tbl-wrap">
                <div className="tbl-scroll">
                  <table className={`tbl tbl-cards text-sm ${loadingNuevos ? 'opacity-60' : ''}`}>
                    <thead>
                      <tr>
                        <th>Paciente</th>
                        <th>Agendado por</th>
                        <th>Agendada el</th>
                        <th>Considerado nuevo</th>
                        <th>Cita</th>
                        <th>Estado</th>
                        <th>Ir a</th>
                      </tr>
                    </thead>
                    <tbody>
                      {nuevosCC.patients.map((p) => (
                        <tr key={p.appointmentId}>
                          <td data-cell="principal">
                            <span className="font-medium text-slate-800">{p.patient}</span>
                            {p.patientRegisteredAt && (
                              <span className="block text-[11px] text-slate-400">
                                Registrado el {fmtDate(p.patientRegisteredAt)}
                              </span>
                            )}
                          </td>
                          <td data-cell="detalle">
                            {p.agent}
                            {p.agentInactive && (
                              <span className="ml-1.5 inline-flex px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-rose-100 text-rose-700">
                                Desactivado
                              </span>
                            )}
                          </td>
                          <td data-cell="detalle">
                            <span className="md:hidden text-slate-400">Agendada: </span>
                            {fmtDateTime(p.scheduledAt)}
                          </td>
                          <td data-cell="detalle">
                            <span className="md:hidden text-slate-400">Nuevo desde (asistió): </span>
                            {fmtDateTime(p.markedNewAt)}
                          </td>
                          <td data-cell="detalle">
                            <span className="md:hidden text-slate-400">Cita: </span>
                            {fmtDate(p.appointmentDate)}{p.startTime ? ` ${p.startTime}` : ''}
                            <span className="block text-[11px] text-slate-400">
                              {[p.clinic, p.services.join(', ')].filter(Boolean).join(' · ')}
                            </span>
                          </td>
                          <td data-cell="estado">
                            <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-semibold ${STATUS_COLORS[p.status] || 'bg-slate-100 text-slate-600'}`}>
                              {statusLabel(p.status)}
                            </span>
                            {p.attendedAt && (
                              <span className="block text-[11px] text-slate-400 mt-0.5">
                                Asistió el {fmtDate(p.attendedAt)}
                              </span>
                            )}
                          </td>
                          {/* Se abren en otra pestaña: así el listado (con su
                              página y filtros) sigue aquí al volver. */}
                          <td data-cell="acciones">
                            <div className="flex flex-wrap gap-1">
                              {p.chatId ? (
                                <Link to={`/chats?chat=${p.chatId}`} target="_blank" rel="noopener" className={irA} title="Abrir el chat del paciente">
                                  <HiOutlineChatBubbleLeftRight className="w-3.5 h-3.5" /> Chat
                                </Link>
                              ) : (
                                <span className={`${irA} opacity-40 cursor-not-allowed`} title="Este paciente no tiene chat">
                                  <HiOutlineChatBubbleLeftRight className="w-3.5 h-3.5" /> Chat
                                </span>
                              )}
                              <Link to={`/appointments?cita=${p.appointmentId}`} target="_blank" rel="noopener" className={irA} title="Abrir la cita en la que quedó marcado como nuevo">
                                <HiOutlineCalendarDays className="w-3.5 h-3.5" /> Cita
                              </Link>
                              {p.patientId && (
                                <Link to={`/patients/${p.patientId}?tab=seguimientos`} target="_blank" rel="noopener" className={irA} title="Ver los seguimientos del paciente">
                                  <HiOutlineHeart className="w-3.5 h-3.5" /> Seguimientos
                                </Link>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
            {nuevosCC && nuevosCC.patients.length > 0 && (
              <Paginador
                pagination={nuevosCC.pagination}
                onPage={(p) => {
                  setPageNuevos(p);
                  document.getElementById('nuevos-cc')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
                unidad="pacientes"
              />
            )}
          </div>
        </div>
      )}

      <Modal
        isOpen={!!commissionEditor}
        onClose={() => !savingCommission && setCommissionEditor(null)}
        title={editorTitle}
        size="sm"
      >
        {commissionEditor && (
          <form onSubmit={saveCommission} className="space-y-4">
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2.5 text-sm">
              <div className="font-semibold text-slate-800">{commissionEditor.doctor.name}</div>
              <div className="text-slate-500">
                {commissionEditor.scope === 'patient' && 'Cada paciente atendido'}
                {commissionEditor.scope === 'service' && commissionEditor.service.name}
                {commissionEditor.scope === 'referral' && (commissionEditor.service
                  ? `Derivaciones a ${commissionEditor.service.name}`
                  : 'Cualquier derivación sin tarifa propia')}
              </div>
              {(editorClinics(commissionEditor) || []).length > 1 && (
                <div className="text-xs text-sky-700 mt-1">
                  Se aplicará en {editorClinics(commissionEditor).length} sucursales del resultado.
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
                Esta comisión se paga una vez por cita atendida. Si la cita tiene un servicio con comisión propia, se paga la del servicio y esta base no se suma.
              </p>
            )}

            {commissionEditor.scope === 'referral' && (
              <p className="text-xs text-violet-700 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
                El doctor gana esta comisión solo cuando el paciente <b>se realiza</b> la derivación (la cita derivada queda asistida o completada). Si el paciente no se la hace, no gana nada.
                {!commissionEditor.service && ' Un servicio derivado con tarifa propia usa la suya en vez de esta.'}
              </p>
            )}

            <label className="block text-sm text-slate-700">Forma de cálculo
              <select
                value={commissionForm.amountType}
                onChange={(e) => setCommissionForm({ ...commissionForm, amountType: e.target.value })}
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2.5 bg-white"
              >
                <option value="fixed">{commissionEditor.scope === 'referral' ? 'Valor fijo por derivación realizada' : 'Valor fijo por cita atendida'}</option>
                <option value="percent">{commissionEditor.scope === 'referral' ? 'Porcentaje de lo que pagó el paciente en la cita derivada' : 'Porcentaje del valor cobrado'}</option>
              </select>
            </label>

            <label className="block text-sm text-slate-700">
              {commissionForm.amountType === 'percent' ? 'Porcentaje (%)' : 'Valor fijo ($)'}
              {commissionForm.timeBands.length > 0 && (
                <span className="text-xs text-slate-400"> — fuera de los horarios de abajo</span>
              )}
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

            {/* TARIFA POR HORARIO: el mismo servicio paga distinto según la hora
                a la que empieza la cita (p. ej. mañana y tarde). */}
            <div className="rounded-xl border border-slate-200 px-3 py-2.5 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-semibold text-slate-700">Valor según el horario</span>
                <button
                  type="button"
                  onClick={addBand}
                  className="text-xs text-emerald-700 hover:underline bg-transparent border-none cursor-pointer"
                >
                  + Agregar horario
                </button>
              </div>
              {commissionForm.timeBands.length === 0 ? (
                <p className="text-xs text-slate-400">
                  Opcional. Úsalo si el doctor gana distinto en la mañana y en la tarde. Sin horarios, paga el mismo valor todo el día.
                </p>
              ) : (
                <>
                  {commissionForm.timeBands.map((b, i) => (
                    <div key={i} className="flex flex-wrap items-center gap-1.5 text-xs">
                      <span className="text-slate-500">De</span>
                      <input
                        type="time"
                        value={b.startTime}
                        onChange={(e) => setBand(i, { startTime: e.target.value })}
                        className="border border-slate-200 rounded-lg px-2 py-1.5"
                      />
                      <span className="text-slate-500">a</span>
                      <input
                        type="time"
                        value={b.endTime}
                        onChange={(e) => setBand(i, { endTime: e.target.value })}
                        className="border border-slate-200 rounded-lg px-2 py-1.5"
                      />
                      <select
                        value={b.amountType}
                        onChange={(e) => setBand(i, { amountType: e.target.value })}
                        className="border border-slate-200 rounded-lg px-1.5 py-1.5 bg-white"
                      >
                        <option value="fixed">$</option>
                        <option value="percent">%</option>
                      </select>
                      <NumericInput
                        value={b.value}
                        onChange={(e) => setBand(i, { value: e.target.value })}
                        min="0"
                        max={b.amountType === 'percent' ? '100' : undefined}
                        required
                        placeholder={b.amountType === 'percent' ? '%' : '$'}
                        className="w-20 border border-slate-200 rounded-lg px-2 py-1.5"
                      />
                      <button
                        type="button"
                        onClick={() => removeBand(i)}
                        title="Quitar horario"
                        className="text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer text-sm leading-none"
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                  <p className="text-[11px] text-slate-400">
                    Cuenta la hora de inicio de la cita: una cita de las 13:00 entra en «13:00 a 19:00», no en «07:00 a 13:00». Si no cae en ningún horario se paga el valor general.
                  </p>
                </>
              )}
            </div>

            {commissionEditor.scope === 'service' && (
              <label className="flex items-start gap-2 text-sm text-slate-700 cursor-pointer bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={commissionForm.firstTimeOnly}
                  onChange={(e) => setCommissionForm({ ...commissionForm, firstTimeOnly: e.target.checked })}
                  className="mt-0.5 accent-emerald-600"
                />
                <span>
                  <b>Solo la primera vez</b> que el paciente recibe este servicio
                  <span className="block text-xs text-slate-500 mt-0.5">
                    Si el paciente vuelve a hacérselo (con cualquier doctor o en cualquier sucursal), el doctor ya no gana comisión por esa cita.
                  </span>
                </span>
              </label>
            )}

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
                Período: {fmtDate(start)} — {fmtDate(end)}
              </div>
              <div className="text-xs text-emerald-700 mt-1">
                Comisión calculada por el sistema: {money(adjustEditor.commissionTotal)}
              </div>
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

      <Modal
        isOpen={!!payout}
        onClose={() => !savingPayout && setPayout(null)}
        title="Marcar comisiones como pagadas"
        size="sm"
      >
        {payout && (
          <form onSubmit={savePayout} className="space-y-4">
            <div className="rounded-xl bg-slate-50 border border-slate-200 px-3 py-2.5 text-sm">
              <div className="font-semibold text-slate-800">{payout.name}</div>
              {doctorRolesLabel(payout.doctor) && (
                <div className="text-xs text-slate-500">{doctorRolesLabel(payout.doctor)}</div>
              )}
            </div>
            <p className="text-xs text-teal-800 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2">
              Elige el período que se le paga (p. ej. la primera quincena del mes). Sus comisiones de citas dentro de esas fechas quedan como <b>pagadas</b> y dejan de sumar en «Por pagar». Se puede deshacer desde su tarjeta.
            </p>
            <div className="flex flex-wrap gap-3">
              <label className="text-sm">Desde
                <DateInput value={payout.start} onChange={(e) => setPayout({ ...payout, start: e.target.value })} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
              </label>
              <label className="text-sm">Hasta
                <DateInput value={payout.end} onChange={(e) => setPayout({ ...payout, end: e.target.value })} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" />
              </label>
              <div className="text-xs text-slate-500 self-end pb-2">
                Sucursal: <b>{clinic === 'all' ? 'todas' : (clinics.find((c) => c._id === clinic)?.nombreComercial || clinics.find((c) => c._id === clinic)?.name || 'la elegida')}</b>
              </div>
            </div>

            {/* Lo del doctor EN EL PERÍODO DEL PAGO, recalculado al cambiar las fechas. */}
            <div className="grid grid-cols-3 gap-2">
              {loadingPreview ? (
                <div className="col-span-3 text-sm text-slate-400 px-1 py-2">Calculando lo pendiente del período...</div>
              ) : (
                <>
                  <Stat label="Ganado" tone="emerald" value={money(payoutPreview?.commissionTotalWithAdjustments)} />
                  <Stat label="Ya pagado" tone="teal" value={money(payoutPreview?.paidTotal)} />
                  <Stat label="A pagar ahora" tone="amber" value={money(payoutTotal)} />
                </>
              )}
            </div>
            {!loadingPreview && !(payoutTotal > 0) && (
              <p className="text-xs text-slate-500">No tiene comisiones pendientes en ese período.</p>
            )}

            <label className="block text-sm text-slate-700">
              Observación (opcional)
              <input
                value={payout.note}
                onChange={(e) => setPayout({ ...payout, note: e.target.value })}
                placeholder="Ej. transferencia del 16/09"
                className="block w-full mt-1 border border-slate-200 rounded-xl px-3 py-2.5"
              />
            </label>

            <div className="flex items-center justify-end gap-3 pt-1">
              <div className="flex gap-2">
                <button type="button" onClick={() => setPayout(null)} disabled={savingPayout} className="px-3 py-2 text-sm border border-slate-200 rounded-xl bg-white cursor-pointer disabled:opacity-50">
                  Cancelar
                </button>
                <button
                  disabled={savingPayout || loadingPreview || !(payoutTotal > 0)}
                  className="px-4 py-2 text-sm bg-teal-600 text-white rounded-xl border-none cursor-pointer disabled:opacity-50"
                >
                  {savingPayout ? 'Guardando...' : 'Marcar como pagado'}
                </button>
              </div>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
