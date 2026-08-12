import { useState, useEffect, useRef, useMemo, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/axios';
import Modal from '../components/Modal';
import { downloadFile } from '../utils/download';
import ProductAutocomplete from '../components/ProductAutocomplete';
import SameSlotPanel from '../components/SameSlotPanel';
import AttendChargeModal from '../components/AttendChargeModal';
import NurseFinishModal from '../components/NurseFinishModal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';
import { fmtDateTime, todayEc, nowEcHHMM } from '../utils/date';
import NumericInput from '../components/NumericInput';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineEye,
  HiOutlineDocumentArrowDown,
  HiOutlinePlay,
  HiOutlineStop,
  HiOutlineMagnifyingGlass,
  HiOutlineUserPlus,
} from 'react-icons/hi2';
import DateInput from '../components/DateInput';
import { doctorOptionLabel } from '../utils/roles';

// 6 estados soportados por el backend.
const statusColors = {
  pendiente: 'bg-slate-100 text-slate-700',
  confirmada: 'bg-blue-100 text-blue-700',
  asistida: 'bg-emerald-100 text-emerald-700',
  no_asistio: 'bg-rose-100 text-rose-700',
  cancelada: 'bg-amber-100 text-amber-700',
  completada: 'bg-teal-100 text-teal-700',
};

const statusLabels = {
  pendiente: 'Pendiente',
  confirmada: 'Confirmada',
  asistida: 'Asistida',
  no_asistio: 'No asistió',
  cancelada: 'Cancelada',
  completada: 'Completada',
};

const normalizeStatus = (s) => {
  const valid = ['pendiente', 'confirmada', 'asistida', 'no_asistio', 'cancelada', 'completada'];
  return valid.includes(s) ? s : 'pendiente';
};

const emptyForm = {
  patient: '',
  // El doctor YA NO se asigna al crear la cita; lo asigna recepción al marcar 'asistida'.
  doctor: '',
  room: '',
  date: '',
  startTime: '',
  // endTime eliminado del flujo de creación
  status: 'pendiente',
  reason: '',
  notes: '',
  diagnosis: '',
  treatment: '',
  services: [],
  clinic: '',
  paidInAdvance: false,
  advanceAmount: 0,
  // Citas adicionales para agendar en una sola operación (solo al crear).
  // Cada entrada: { date, startTime, reason, services: [productId] }
  extraAppointments: [],
};

const roleLabels = {
  admin: 'Administrador',
  cajero: 'Cajero',
  doctor: 'Doctor',
  ginecologia: 'Ginecología',
  optica: 'Óptica',
  contabilidad: 'Contabilidad',
  call_center: 'Call Center',
  marketing: 'Marketing',
  enfermero: 'Enfermero/a',
};

// Formatea una fecha ISO usando los componentes de fecha (sin convertir a UTC).
const formatLocalDate = (iso) => {
  if (!iso) return '';
  const str = String(iso);
  const m = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    return `${d}/${mo}/${y}`;
  }
  const dt = new Date(str);
  return Number.isNaN(dt.getTime()) ? '' : dt.toLocaleDateString('es-EC');
};

// YYYY-MM-DD a partir de componentes locales (sin desfase UTC).
const toYmd = (d) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const MONTH_NAMES = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
];
const WEEKDAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

// Convierte HH:MM a minutos
const hhmmToMin = (s) => {
  if (!s) return null;
  const m = String(s).match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

export default function Appointments() {
  const navigate = useNavigate();
  const { user, role, hasRole, activeClinic, clinics } = useAuth();
  const canWrite = hasRole('admin', 'cajero', 'call_center');
  const isAdmin = hasRole('admin') || user?.isSuperAdmin;
  const isDoctor = role === 'doctor' || role === 'optica' || role === 'ginecologia';
  const isNurse = role === 'enfermero';
  const isCallCenter = role === 'call_center';
  const isReception = hasRole('admin', 'cajero', 'enfermero');
  // Quién puede ejecutar el flujo asistir → cobrar → derivar (requiere cobrar).
  const canCharge = hasRole('admin', 'cajero');
  // Mostrar selector de clínica si el usuario tiene más de una asignada
  const showClinicSelector = (clinics?.length || 0) > 1;

  const [appointments, setAppointments] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [patients, setPatients] = useState([]);
  const [services, setServices] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModal, setDetailModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  // Modal para asignar doctor al marcar 'asistida'
  const [assignModal, setAssignModal] = useState(null); // { appointment }
  // Modal de finalización de enfermería (cita reclamada por el enfermero)
  const [nurseFinish, setNurseFinish] = useState(null); // appointment
  const [filter, setFilter] = useState({
    startDate: '',
    endDate: '',
    status: '',
    isFirstVisit: '',
    clinic: '',
    service: '',
    timeFrom: '',
    timeTo: '',
    patientQuery: '',
  });
  const [view, setView] = useState(
    role === 'doctor' || role === 'optica' || role === 'ginecologia'
      ? 'list'
      : 'calendar'
  ); // 'calendar' | 'list'
  // Mes visible en la vista calendario
  const [calMonth, setCalMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  // Día seleccionado en la vista lista (YYYY-MM-DD). La lista muestra solo ese día.
  const [listDay, setListDay] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [patientSearch, setPatientSearch] = useState('');
  const [showPatientList, setShowPatientList] = useState(false);

  // Cronómetro
  const [timerAppt, setTimerAppt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const [timeUpModal, setTimeUpModal] = useState(null);
  const notifiedRef = useRef(new Set());

  const fetchAppointments = async () => {
    try {
      const params = {};
      if (view === 'calendar') {
        // Trae todas las citas del mes visible para pintarlas en la cuadrícula.
        const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
        const last = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0);
        params.startDate = toYmd(first);
        params.endDate = toYmd(last);
        if (filter.status) params.status = filter.status;
      } else {
        // Lista = un solo día (navegable por flechas).
        params.startDate = listDay;
        params.endDate = listDay;
        if (filter.status) params.status = filter.status;
      }
      if (filter.isFirstVisit) params.isFirstVisit = filter.isFirstVisit;
      if (filter.patientQuery && filter.patientQuery.trim()) params.q = filter.patientQuery.trim();
      // Vista unificada: trae las citas de TODAS las sucursales del usuario para que
      // ninguna quede oculta por la sucursal activa (la cita puede tener otra
      // "sucursal destino"). Cada tarjeta muestra a qué sucursal pertenece.
      params.clinic = 'all';
      const res = await api.get('/appointments', { params });
      const list = (res.data || []).map((a) => ({
        ...a,
        status: normalizeStatus(a.status),
      }));
      setAppointments(list);
    } catch {
      toast.error('Error al cargar citas');
    } finally {
      setLoading(false);
    }
  };

  const fetchDoctors = async () => {
    try {
      const res = await api.get('/users/doctors');
      setDoctors(res.data);
    } catch {
      // silent
    }
  };

  const fetchPatients = async () => {
    try {
      const res = await api.get('/patients', { params: { limit: 1000 } });
      setPatients(res.data.patients);
    } catch {
      // silent
    }
  };

  const fetchServices = async () => {
    try {
      const res = await api.get('/products', { params: { limit: 500 } });
      // Incluir también los programas (paquetes de varios servicios) al agendar.
      const list = (res.data || []).filter(
        (p) => p.active !== false && (p.category === 'servicio' || p.category === 'programa' || p.unlimited === true)
      );
      setServices(list);
    } catch {
      // silent
    }
  };

  const fetchRooms = async () => {
    try {
      const res = await api.get('/rooms');
      setRooms(res.data || []);
    } catch {
      // silent
    }
  };

  useEffect(() => {
    fetchDoctors();
    fetchPatients();
    fetchServices();
    fetchRooms();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    fetchAppointments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, filter, calMonth, listDay]);

  // Tiempo real: cuando llega un cambio de cita, refrescar la lista.
  useSocketEvent('appointment:created', () => fetchAppointments());
  useSocketEvent('appointment:updated', () => fetchAppointments());
  useSocketEvent('appointment:deleted', () => fetchAppointments());

  // Tick global del cronómetro (1s)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Detectar fin de tiempo programado y disparar el modal
  useEffect(() => {
    if (!isDoctor) return;
    appointments.forEach((apt) => {
      if (
        apt.consultationStartedAt &&
        !apt.consultationEndedAt &&
        apt.status !== 'completada'
      ) {
        const startMs = new Date(apt.consultationStartedAt).getTime();
        const startMin = hhmmToMin(apt.startTime);
        const endMin = hhmmToMin(apt.endTime);
        const durationMs = (endMin - startMin) * 60 * 1000;
        if (now - startMs >= durationMs && !notifiedRef.current.has(apt._id)) {
          notifiedRef.current.add(apt._id);
          setTimeUpModal(apt);
        }
      }
    });
  }, [now, appointments, isDoctor]);

  const canEdit = (apt) => {
    // Una cita completada solo puede ser editada por administradores
    if (apt.status === 'completada' && !isAdmin) return false;
    if (isAdmin) return true;
    if (isDoctor && String(apt.doctor?._id || apt.doctor) === String(user?.id)) return true;
    return String(apt.createdBy?._id || apt.createdBy) === String(user?.id);
  };

  // Cita que se está editando: hace falta su estado real (no solo el del
  // formulario) para saber si el doctor todavía se puede reasignar.
  const editingAppointment = editing ? appointments.find((a) => a._id === editing) : null;
  // Una vez atendida, el doctor queda fijo: la consulta y su comisión ya son
  // suyas. El backend aplica la misma regla; esto solo evita el intento.
  const doctorLocked =
    !!editingAppointment?.doctor &&
    (editingAppointment.status === 'completada' || !!editingAppointment.consultationEndedAt);

  const openNew = () => {
    setEditing(null);
    setForm({
      ...emptyForm,
      clinic: activeClinic?._id || '',
    });
    setPatientSearch('');
    setModalOpen(true);
  };

  const openEdit = (apt) => {
    if (!canEdit(apt)) {
      toast.error('Solo el creador o un administrador puede editar esta cita.');
      return;
    }
    setEditing(apt._id);
    setForm({
      patient: apt.patient?._id || '',
      doctor: apt.doctor?._id || '',
      room: apt.room?._id || apt.room || '',
      date: apt.date ? apt.date.split('T')[0] : '',
      startTime: apt.startTime,
      endTime: apt.endTime,
      status: normalizeStatus(apt.status),
      reason: apt.reason || '',
      notes: apt.notes || '',
      diagnosis: apt.diagnosis || '',
      treatment: apt.treatment || '',
      services: (apt.services || [])
        .map((s) => s.product?._id || s.product || s._id)
        .filter(Boolean),
      clinic: apt.clinic || activeClinic?._id || '',
      paidInAdvance: !!apt.paidInAdvance,
      advanceAmount: Number(apt.advanceAmount || 0),
    });
    setPatientSearch(
      apt.patient ? `${apt.patient.firstName} ${apt.patient.lastName} - ${apt.patient.cedula}` : ''
    );
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!form.patient) {
      toast.error('Selecciona un paciente');
      return;
    }
    // El servicio es obligatorio para la cita principal.
    if (!Array.isArray(form.services) || form.services.length === 0) {
      toast.error('Selecciona al menos un servicio para la cita');
      return;
    }
    // Y también para cada cita adicional (cuando se crean varias).
    if (!editing) {
      const extras = (form.extraAppointments || []).filter((it) => it.date && it.startTime);
      const extraSinServicio = extras.findIndex(
        (it) => !Array.isArray(it.services) || it.services.length === 0
      );
      if (extraSinServicio >= 0) {
        toast.error(`La cita adicional #${extraSinServicio + 2} requiere al menos un servicio`);
        return;
      }
    }
    setSaving(true);
    try {
      const basePayload = {
        ...form,
        services: (form.services || []).map((id) => ({ product: id })),
      };
      delete basePayload.extraAppointments;
      if (!basePayload.endTime) delete basePayload.endTime;
      if (editing) {
        await api.put(`/appointments/${editing}`, basePayload);
        toast.success('Cita actualizada');
      } else {
        // Primero la cita principal
        await api.post('/appointments', basePayload);
        // Luego cada cita adicional con los mismos datos compartidos
        const extras = (form.extraAppointments || []).filter((it) => it.date && it.startTime);
        for (const it of extras) {
          const extraPayload = {
            ...basePayload,
            date: it.date,
            startTime: it.startTime,
            reason: it.reason || basePayload.reason,
            services: (it.services || []).map((id) => ({ product: id })),
          };
          // eslint-disable-next-line no-await-in-loop
          await api.post('/appointments', extraPayload);
        }
        const totalCreated = 1 + extras.length;
        toast.success(totalCreated > 1 ? `${totalCreated} citas creadas` : 'Cita creada');
      }
      setModalOpen(false);
      fetchAppointments();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (apt) => {
    if (!canEdit(apt)) {
      toast.error('Solo el creador o un administrador puede eliminar esta cita.');
      return;
    }
    if (!window.confirm('¿Eliminar esta cita?')) return;
    try {
      await api.delete(`/appointments/${apt._id}`);
      toast.success('Cita eliminada');
      fetchAppointments();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar');
    }
  };

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  const downloadPdf = async (id) => {
    try {
      await downloadFile(`/appointments/${id}/pdf`, { filename: `cita_${id}.pdf` });
    } catch (err) {
      toast.error(err.message || 'Error al descargar PDF');
    }
  };

  const exportExcel = async () => {
    try {
      const params = {};
      if (view === 'calendar') {
        const first = new Date(calMonth.getFullYear(), calMonth.getMonth(), 1);
        const last = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 0);
        params.startDate = toYmd(first);
        params.endDate = toYmd(last);
        if (filter.status) params.status = filter.status;
      } else {
        params.startDate = listDay;
        params.endDate = listDay;
        if (filter.status) params.status = filter.status;
      }
      await downloadFile('/reports/appointments.xlsx', { params, filename: `citas_${Date.now()}.xlsx` });
    } catch (err) {
      toast.error(err.message || 'Error al exportar');
    }
  };

  const openDetail = async (id) => {
    try {
      const res = await api.get(`/appointments/${id}`);
      setDetailModal({ ...res.data, status: normalizeStatus(res.data.status) });
    } catch {
      toast.error('Error al cargar detalle');
    }
  };

  const startConsultation = async (apt) => {
    try {
      await api.post(`/appointments/${apt._id}/start`);
      toast.success('Consulta iniciada');
      fetchAppointments();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al iniciar');
    }
  };

  const endConsultation = async (apt) => {
    try {
      await api.post(`/appointments/${apt._id}/end`);
      toast.success('Consulta finalizada');
      fetchAppointments();
      setTimeUpModal(null);
      notifiedRef.current.delete(apt._id);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al finalizar');
    }
  };

  const nurseClaim = async (apt) => {
    if (!window.confirm(`¿Confirmas que vas a atender a ${apt.patient?.firstName || ''} ${apt.patient?.lastName || ''}?`)) return;
    try {
      await api.post(`/appointments/${apt._id}/nurse-claim`);
      toast.success('Cita asignada a ti. Finalízala cuando termines.');
      fetchAppointments();
    } catch (err) {
      toast.error(err.response?.data?.message || 'No se pudo reclamar la cita');
    }
  };

  const handlePatientSelect = (p) => {
    setForm((f) => ({ ...f, patient: p._id }));
    setPatientSearch(`${p.firstName} ${p.lastName} - ${p.cedula}`);
    setShowPatientList(false);
  };

  const filteredPatients = useMemo(() => {
    const q = patientSearch.toLowerCase().trim();
    if (!q) return patients.slice(0, 30);
    return patients
      .filter(
        (p) =>
          p.firstName?.toLowerCase().includes(q) ||
          p.lastName?.toLowerCase().includes(q) ||
          p.cedula?.includes(q) ||
          p.phone?.includes(q)
      )
      .slice(0, 30);
  }, [patientSearch, patients]);

  // Aplica filtros en el cliente para servicio/sucursal/rango horario.
  // Ordena cronológicamente (por fecha y hora) para verlas en forma de HORARIO,
  // no en el orden en que se agendaron.
  const filteredAppointments = useMemo(() => {
    return appointments
      .filter((apt) => {
        if (filter.service) {
          const has = (apt.services || []).some(
            (s) => String(s.product?._id || s.product) === String(filter.service)
          );
          if (!has) return false;
        }
        if (filter.clinic) {
          const c = apt.clinic?._id || apt.clinic;
          if (String(c) !== String(filter.clinic)) return false;
        }
        if (filter.timeFrom && apt.startTime && apt.startTime < filter.timeFrom) return false;
        if (filter.timeTo && apt.startTime && apt.startTime > filter.timeTo) return false;
        return true;
      })
      .sort((a, b) => {
        const da = new Date(a.date).getTime();
        const db = new Date(b.date).getTime();
        if (da !== db) return da - db;
        return String(a.startTime || '').localeCompare(String(b.startTime || ''));
      });
  }, [appointments, filter.service, filter.clinic, filter.timeFrom, filter.timeTo]);

  // Agrupa las citas (ya filtradas) por día YYYY-MM-DD para pintar la cuadrícula.
  const calApptsByDay = useMemo(() => {
    const map = new Map();
    filteredAppointments.forEach((a) => {
      const k = String(a.date || '').slice(0, 10);
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(a);
    });
    return map;
  }, [filteredAppointments]);

  // Celdas del mes (con relleno para alinear a lunes). null = celda vacía.
  const calendarCells = useMemo(() => {
    const year = calMonth.getFullYear();
    const month = calMonth.getMonth();
    const first = new Date(year, month, 1);
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const leading = (first.getDay() + 6) % 7; // lunes = 0
    const cells = [];
    for (let i = 0; i < leading; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  }, [calMonth]);

  const moveMonth = (dir) => {
    setCalMonth((m) => new Date(m.getFullYear(), m.getMonth() + dir, 1));
  };

  // Click en un día del calendario → ver la tabla de ese día (orden por horario).
  const openDay = (d) => {
    setListDay(toYmd(d));
    setView('list');
  };

  // Navegación de día (vista lista): ±1 día.
  const moveDay = (delta) => {
    setListDay((cur) => {
      const [y, m, d] = cur.split('-').map(Number);
      const nd = new Date(y, m - 1, d + delta);
      return toYmd(nd);
    });
  };

  // Cronómetro de cita seleccionada
  const elapsedSeconds = (apt) => {
    if (!apt?.consultationStartedAt) return 0;
    const start = new Date(apt.consultationStartedAt).getTime();
    return Math.max(0, Math.floor((now - start) / 1000));
  };

  const fmtSeconds = (s) => {
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  };

  return (
    <div>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Citas y Calendario</h1>
          <p className="text-sm text-slate-500 mt-1">Agenda y seguimiento de consultas</p>
        </div>
        <div className="flex gap-2">
          {!isDoctor && (
            <div className="inline-flex rounded-xl border border-slate-200 overflow-hidden bg-white">
              {[['calendar', 'Calendario'], ['list', 'Lista']].map(([v, label]) => (
                <button
                  key={v}
                  onClick={() => setView(v)}
                  className={`px-4 py-2.5 text-sm font-medium cursor-pointer border-none transition-colors ${
                    view === v
                      ? 'bg-emerald-600 text-white'
                      : 'bg-white text-slate-600 hover:bg-emerald-50'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {isAdmin && (
            <button
              onClick={exportExcel}
              className="px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"
            >
              Excel
            </button>
          )}
          {canWrite && (
            <button
              onClick={openNew}
              className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50 transition-all"
            >
              <HiOutlinePlus className="w-5 h-5" /> Nueva Cita
            </button>
          )}
        </div>
      </div>

      {(view === 'list' || view === 'calendar') && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 mb-6 p-4 space-y-3">
          <div className="relative">
            <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              value={filter.patientQuery}
              onChange={(e) => setFilter({ ...filter, patientQuery: e.target.value })}
              placeholder="Buscar paciente por nombre, cédula o teléfono..."
              className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
            />
          </div>
          {/* Navegación de día (solo lista): la lista muestra un único día. */}
          {view === 'list' && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              <button
                onClick={() => moveDay(-1)}
                className="px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer text-sm"
              >
                ‹ Día anterior
              </button>
              <DateInput
                value={listDay}
                onChange={(e) => setListDay(e.target.value)}
                className="px-4 py-2 border border-slate-200 rounded-xl text-sm bg-slate-50/50"
              />
              <button
                onClick={() => moveDay(1)}
                className="px-3 py-2 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer text-sm"
              >
                Día siguiente ›
              </button>
              <button
                onClick={() => setListDay(toYmd(new Date()))}
                className={`px-3 py-2 rounded-lg cursor-pointer text-sm transition-colors ${
                  listDay === toYmd(new Date())
                    ? 'bg-emerald-600 text-white border-none'
                    : 'bg-white text-slate-600 border border-slate-200 hover:bg-slate-50'
                }`}
              >
                Hoy
              </button>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <select
              value={filter.status}
              onChange={(e) => setFilter({ ...filter, status: e.target.value })}
              className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
            >
              <option value="">Todos los estados</option>
              {Object.entries(statusLabels).map(([k, v]) => (
                <option key={k} value={k}>{v}</option>
              ))}
            </select>
            <select
              value={filter.isFirstVisit}
              onChange={(e) => setFilter({ ...filter, isFirstVisit: e.target.value })}
              className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
            >
              <option value="">Todos los pacientes</option>
              <option value="true">Solo pacientes nuevos</option>
              <option value="false">Solo pacientes recurrentes</option>
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            {!isDoctor && (
              <ProductAutocomplete
                products={services}
                value={filter.service}
                onSelect={(p) => setFilter({ ...filter, service: p?._id || '' })}
                placeholder="Filtrar por servicio..."
              />
            )}
            {!isDoctor && (clinics?.length || 0) > 1 && (
              <select
                value={filter.clinic}
                onChange={(e) => setFilter({ ...filter, clinic: e.target.value })}
                className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50"
              >
                <option value="">Todas las sucursales</option>
                {clinics.map((c) => (
                  <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>
                ))}
              </select>
            )}
            {/* Filtros por hora: solo tienen sentido en la lista (un día). */}
            {view === 'list' && (
              <>
                <input
                  type="time"
                  value={filter.timeFrom}
                  onChange={(e) => setFilter({ ...filter, timeFrom: e.target.value })}
                  className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50"
                  placeholder="Desde hora"
                />
                <input
                  type="time"
                  value={filter.timeTo}
                  onChange={(e) => setFilter({ ...filter, timeTo: e.target.value })}
                  className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50"
                  placeholder="Hasta hora"
                />
              </>
            )}
          </div>
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Total filtrado: <strong className="text-slate-800">{filteredAppointments.length}</strong> citas</span>
            {(filter.service || filter.clinic || filter.timeFrom || filter.timeTo || filter.status || filter.isFirstVisit || filter.patientQuery) && (
              <button
                onClick={() => setFilter({ startDate: '', endDate: '', status: '', isFirstVisit: '', clinic: '', service: '', timeFrom: '', timeTo: '', patientQuery: '' })}
                className="text-emerald-600 hover:underline border-none bg-transparent cursor-pointer"
              >Limpiar filtros</button>
            )}
          </div>
        </div>
      )}

      {view === 'calendar' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden mb-6">
          {/* Navegación de mes */}
          <div className="flex items-center justify-between px-5 py-3 border-b border-emerald-50">
            <button
              onClick={() => moveMonth(-1)}
              className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer"
            >
              ‹
            </button>
            <h2 className="text-base font-semibold text-slate-800">
              {MONTH_NAMES[calMonth.getMonth()]} {calMonth.getFullYear()}
            </h2>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setCalMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
                className="px-3 py-1.5 rounded-lg text-sm bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer"
              >
                Hoy
              </button>
              <button
                onClick={() => moveMonth(1)}
                className="px-3 py-1.5 rounded-lg bg-white border border-slate-200 hover:bg-slate-50 cursor-pointer"
              >
                ›
              </button>
            </div>
          </div>
          {/* Cabecera de días */}
          <div className="grid grid-cols-7 bg-emerald-50/40 text-emerald-700 text-xs font-semibold">
            {WEEKDAY_NAMES.map((w) => (
              <div key={w} className="text-center py-2">{w}</div>
            ))}
          </div>
          {/* Cuadrícula del mes */}
          <div className="grid grid-cols-7">
            {calendarCells.map((d, idx) => {
              if (!d) return <div key={`e${idx}`} className="border-t border-l border-slate-100 min-h-[92px] bg-slate-50/30" />;
              const ymd = toYmd(d);
              const dayAppts = calApptsByDay.get(ymd) || [];
              const isToday = ymd === toYmd(new Date());
              const counts = dayAppts.reduce((acc, a) => {
                if (['asistida', 'completada'].includes(a.status)) acc.asistida += 1;
                else if (a.status === 'no_asistio') acc.no_asistio += 1;
                else if (a.status !== 'cancelada') acc.pendiente += 1;
                return acc;
              }, { pendiente: 0, asistida: 0, no_asistio: 0 });
              return (
                <button
                  key={ymd}
                  onClick={() => openDay(d)}
                  className={`text-left border-t border-l border-slate-100 min-h-[92px] p-1.5 cursor-pointer hover:bg-emerald-50/60 transition-colors bg-transparent ${
                    isToday ? 'ring-2 ring-inset ring-emerald-400' : ''
                  }`}
                >
                  <div className={`text-xs font-semibold mb-1 ${isToday ? 'text-emerald-700' : 'text-slate-600'}`}>
                    {d.getDate()}
                  </div>
                  {dayAppts.length > 0 ? (
                    <div className="space-y-0.5">
                      <div className="text-[11px] font-bold text-slate-700">{dayAppts.length} cita{dayAppts.length !== 1 ? 's' : ''}</div>
                      <div className="flex flex-wrap gap-1">
                        {counts.pendiente > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">{counts.pendiente} pend.</span>
                        )}
                        {counts.asistida > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">{counts.asistida} asist.</span>
                        )}
                        {counts.no_asistio > 0 && (
                          <span className="text-[10px] px-1.5 py-0.5 rounded bg-rose-100 text-rose-700">{counts.no_asistio} no</span>
                        )}
                      </div>
                    </div>
                  ) : null}
                </button>
              );
            })}
          </div>
          <div className="px-5 py-2 text-xs text-slate-400 border-t border-slate-100">
            Haz clic en un día para ver sus citas en forma de tabla, ordenadas por horario.
          </div>
        </div>
      )}

      {view !== 'calendar' && (
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl">
            <thead>
              <tr className="bg-emerald-50/50 border-b border-emerald-100">
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Fecha
                </th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Hora
                </th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Paciente
                </th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">
                  Servicio / Programa
                </th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Estado
                </th>
                <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="6" className="text-center py-10 text-slate-500">
                    Cargando...
                  </td>
                </tr>
              ) : filteredAppointments.length === 0 ? (
                <tr>
                  <td colSpan="6" className="text-center py-10 text-slate-500">
                    No se encontraron citas
                  </td>
                </tr>
              ) : (
                filteredAppointments.map((apt, aptIdx) => {
                  const editable = canEdit(apt);
                  const showDoctorTimer =
                    isDoctor &&
                    String(apt.doctor?._id || apt.doctor) === String(user?.id) &&
                    apt.status !== 'completada';
                  const inProgress =
                    apt.consultationStartedAt && !apt.consultationEndedAt;
                  // Separador de fecha: cabecera cuando cambia el día (vista de agenda).
                  const prev = filteredAppointments[aptIdx - 1];
                  const dayKey = formatLocalDate(apt.date);
                  const showDayHeader = !prev || formatLocalDate(prev.date) !== dayKey;
                  return (
                    <Fragment key={apt._id}>
                    {showDayHeader && (
                      <tr className="bg-emerald-50/70">
                        <td colSpan="6" className="px-6 py-2 text-xs font-bold text-emerald-800 uppercase tracking-wide">
                          📅 {dayKey}
                        </td>
                      </tr>
                    )}
                    <tr
                      className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors"
                    >
                      <td className="px-6 py-3.5 text-sm text-slate-600">
                        {formatLocalDate(apt.date)}
                      </td>
                      <td className="px-6 py-3.5 text-sm text-slate-800 font-medium">
                        {apt.startTime}{apt.endTime ? ` - ${apt.endTime}` : ''}
                      </td>
                      <td className="px-6 py-3.5 text-sm text-slate-800">
                        <div className="flex items-center gap-2">
                          <span>
                            {apt.patient?.firstName} {apt.patient?.lastName}
                          </span>
                          {apt.isFirstVisit && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 uppercase">
                              Nuevo
                            </span>
                          )}
                          {clinics.length > 1 && apt.clinic && (
                            <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-indigo-100 text-indigo-700">
                              {apt.clinic.nombreComercial || apt.clinic.name}
                            </span>
                          )}
                        </div>
                        {apt.createdBy && (
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            Por: {apt.createdBy.name}
                            {apt.createdByRole
                              ? ` (${roleLabels[apt.createdByRole] || apt.createdByRole})`
                              : ''}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-3.5 text-sm text-slate-600 hidden md:table-cell">
                        {Array.isArray(apt.services) && apt.services.length > 0
                          ? apt.services.map((s) => s.name || s.product?.name).filter(Boolean).join(', ')
                          : <span className="text-slate-400 italic">Sin servicio</span>}
                        {apt.reason && (
                          <div className="text-[11px] text-slate-500 mt-0.5 italic" title={apt.reason}>
                            Motivo: {apt.reason.length > 60 ? apt.reason.slice(0, 60) + '…' : apt.reason}
                          </div>
                        )}
                        {apt.doctor?.name && (
                          <div className="text-[11px] text-emerald-700 mt-0.5">
                            Dr. {apt.doctor.name}
                          </div>
                        )}
                        {apt.attendedByNurse?.name && (
                          <div className="text-[11px] text-sky-700 mt-0.5">
                            Enf. {apt.attendedByNurse.name}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-3.5">
                        <span
                          className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                            statusColors[apt.status] || statusColors.pendiente
                          }`}
                        >
                          {statusLabels[apt.status] || 'Pendiente'}
                        </span>
                      </td>
                      <td className="px-6 py-3.5 text-right">
                        {/* Recepción/cajero: marcar asistencia → cobrar → derivar */}
                        {canCharge && ['pendiente', 'confirmada'].includes(apt.status) && (
                          <button
                            onClick={() => setAssignModal({ appointment: apt })}
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                            title="Recibir paciente: asistencia + cobro + derivación"
                          >
                            <HiOutlineUserPlus className="w-4 h-4" />
                          </button>
                        )}
                        {/* Doctor: Abrir ficha del paciente cuando la cita ya fue marcada 'asistida' */}
                        {isDoctor &&
                          apt.status === 'asistida' &&
                          String(apt.doctor?._id || apt.doctor) === String(user?.id) && (
                            <button
                              onClick={() => {
                                if (!apt.consultationStartedAt) {
                                  api.post(`/appointments/${apt._id}/start`).catch(() => {});
                                }
                                navigate(`/patients/${apt.patient?._id}?appointment=${apt._id}&tab=ficha`);
                              }}
                              className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-600 bg-transparent border border-emerald-200 cursor-pointer transition-colors text-xs font-semibold mr-1"
                              title="Atender ahora"
                            >
                              Atender
                            </button>
                          )}
                        {/* Enfermero: reclamar una cita de enfermería libre */}
                        {isNurse && apt.status === 'asistida' && !apt.attendedByNurse && (
                          <button
                            onClick={() => nurseClaim(apt)}
                            className="p-1.5 rounded-lg hover:bg-sky-50 text-sky-700 bg-transparent border border-sky-200 cursor-pointer transition-colors text-xs font-semibold mr-1"
                            title="Atender: marcar que la estoy atendiendo"
                          >
                            Atender
                          </button>
                        )}
                        {/* Enfermero: finalizar la cita que reclamó */}
                        {isNurse && apt.status === 'asistida' && String(apt.attendedByNurse?._id || apt.attendedByNurse) === String(user?.id) && (
                          <button
                            onClick={() => setNurseFinish(apt)}
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-emerald-700 bg-transparent border border-emerald-200 cursor-pointer transition-colors text-xs font-semibold mr-1"
                            title="Terminar y registrar"
                          >
                            Terminar
                          </button>
                        )}
                        {showDoctorTimer && !inProgress && apt.status !== 'completada' && (
                          <button
                            onClick={() => startConsultation(apt)}
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                            title="Iniciar consulta"
                          >
                            <HiOutlinePlay className="w-4 h-4" />
                          </button>
                        )}
                        {showDoctorTimer && inProgress && (
                          <button
                            onClick={() => endConsultation(apt)}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer transition-colors"
                            title="Finalizar consulta"
                          >
                            <HiOutlineStop className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => openDetail(apt._id)}
                          className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                        >
                          <HiOutlineEye className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => downloadPdf(apt._id)}
                          className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                          title="Descargar PDF"
                        >
                          <HiOutlineDocumentArrowDown className="w-4 h-4" />
                        </button>
                        {editable && (
                          <button
                            onClick={() => openEdit(apt)}
                            className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors"
                          >
                            <HiOutlinePencil className="w-4 h-4" />
                          </button>
                        )}
                        {editable && canWrite && (
                          <button
                            onClick={() => handleDelete(apt)}
                            className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer transition-colors"
                          >
                            <HiOutlineTrash className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                    </Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Create/Edit Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar Cita' : 'Nueva Cita'}
        size="2xl"
      >
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_320px] gap-5">
          <form onSubmit={handleSubmit} className="space-y-4 min-w-0">
          {/* Selector de consultorio médico: visible para todos los roles con >1 clínica */}
          {showClinicSelector && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Sucursal destino *
              </label>
              <select
                name="clinic"
                value={form.clinic}
                onChange={handleChange}
                required
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              >
                <option value="">Seleccionar sucursal</option>
                {clinics.map((c) => (
                  <option key={c._id} value={c._id}>
                    {c.nombreComercial || c.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Buscador de pacientes */}
          <div className="relative">
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Paciente *
            </label>
            <div className="relative">
              <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                type="text"
                value={patientSearch}
                onChange={(e) => {
                  setPatientSearch(e.target.value);
                  setShowPatientList(true);
                  if (form.patient) setForm((f) => ({ ...f, patient: '' }));
                }}
                onFocus={() => setShowPatientList(true)}
                placeholder="Buscar por nombre o cédula..."
                className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              />
              {form.patient && (
                <button
                  type="button"
                  onClick={() => {
                    setForm((f) => ({ ...f, patient: '' }));
                    setPatientSearch('');
                  }}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-emerald-600 bg-transparent border-none cursor-pointer"
                >
                  Limpiar
                </button>
              )}
            </div>
            {showPatientList && !form.patient && (
              <div className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-emerald-100 rounded-xl shadow-lg">
                {filteredPatients.length === 0 ? (
                  <p className="px-4 py-2 text-xs text-slate-400">Sin coincidencias</p>
                ) : (
                  filteredPatients.map((p) => (
                    <button
                      type="button"
                      key={p._id}
                      onClick={() => handlePatientSelect(p)}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-emerald-50 cursor-pointer bg-white border-none border-b border-emerald-50"
                    >
                      <span className="font-medium text-slate-800">
                        {p.firstName} {p.lastName}
                      </span>
                      <span className="text-slate-400 ml-2">{p.cedula}</span>
                      {p.phone && (
                        <span className="text-slate-400 ml-2">• {p.phone}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {/* Doctor: visible al EDITAR para admin y para quienes asignan doctores
                (cajero / recepción). La comisión se atribuye al doctor asignado. */}
            {editing && (isAdmin || isReception) && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Doctor asignado
                </label>
                <select
                  name="doctor"
                  value={form.doctor}
                  onChange={handleChange}
                  disabled={doctorLocked}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 disabled:bg-slate-100 disabled:text-slate-500 disabled:cursor-not-allowed"
                >
                  <option value="">Sin asignar</option>
                  {doctors.map((d) => (
                    <option key={d._id} value={d._id}>
                      {doctorOptionLabel(d)}
                    </option>
                  ))}
                </select>
                <p className="text-[11px] text-slate-400 mt-1">
                  {doctorLocked
                    ? 'La consulta ya fue atendida: el doctor no se puede cambiar.'
                    : 'La comisión por el servicio se asigna al doctor seleccionado.'}
                </p>
              </div>
            )}
            {editing && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Estado
                </label>
                <select
                  name="status"
                  value={form.status}
                  onChange={handleChange}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
                >
                  {Object.entries(statusLabels).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Fecha *
              </label>
              <DateInput
                name="date"
                value={form.date}
                min={todayEc()}
                onChange={handleChange}
                required
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Hora *
              </label>
              <input
                name="startTime"
                type="time"
                value={form.startTime}
                min={form.date === todayEc() ? nowEcHHMM() : undefined}
                onChange={handleChange}
                required
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Motivo de consulta
            </label>
            <textarea
              name="reason"
              value={form.reason}
              onChange={handleChange}
              rows={2}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Consultorio físico
              </label>
              <select
                name="room"
                value={form.room}
                onChange={handleChange}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 bg-slate-50/50"
              >
                <option value="">— Sin asignar —</option>
                {rooms.map((r) => (
                  <option key={r._id} value={r._id}>{r.name}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col justify-end">
              <label className="flex items-center gap-2 text-sm font-medium text-slate-700 mb-1.5 mt-6">
                <input
                  type="checkbox"
                  checked={form.paidInAdvance}
                  onChange={(e) => setForm({ ...form, paidInAdvance: e.target.checked })}
                  className="w-4 h-4 accent-emerald-600"
                />
                Pagado por adelantado
              </label>
              {form.paidInAdvance && (
                <NumericInput
                  min={0}
                  step="0.01"
                  value={form.advanceAmount}
                  onChange={(e) => setForm({ ...form, advanceAmount: Number(e.target.value) })}
                  placeholder="Monto adelantado"
                  className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50"
                />
              )}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              Servicios *
            </label>
            <ServiceAutocomplete
              services={services}
              selectedIds={form.services}
              onAdd={(id) => setForm((f) => f.services.includes(id) ? f : { ...f, services: [...f.services, id] })}
              onRemove={(id) => setForm((f) => ({ ...f, services: f.services.filter((s) => s !== id) }))}
            />
            {form.services.length === 0 && (
              <p className="text-[11px] text-rose-600 mt-1">Debes seleccionar al menos un servicio.</p>
            )}
            {form.services.length > 0 && (
              <p className="text-xs text-emerald-600 mt-1">
                Total estimado: $
                {form.services
                  .reduce((sum, id) => {
                    const s = services.find((x) => x._id === id);
                    return sum + (s ? Number(s.salePrice) : 0);
                  }, 0)
                  .toFixed(2)}
              </p>
            )}
          </div>

          {/* Citas adicionales: solo al crear (no al editar). */}
          {!editing && (
            <div className="space-y-2">
              {(form.extraAppointments || []).map((it, idx) => (
                <div key={idx} className="border border-emerald-200 rounded-xl p-3 bg-emerald-50/40 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-emerald-700">Cita adicional #{idx + 2}</span>
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({
                        ...f,
                        extraAppointments: f.extraAppointments.filter((_, i) => i !== idx),
                      }))}
                      className="text-rose-600 text-xs bg-transparent border-none cursor-pointer hover:underline"
                    >
                      Quitar
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <DateInput
                      value={it.date}
                      min={todayEc()}
                      onChange={(e) => setForm((f) => ({
                        ...f,
                        extraAppointments: f.extraAppointments.map((x, i) => i === idx ? { ...x, date: e.target.value } : x),
                      }))}
                      className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                    <input
                      type="time"
                      value={it.startTime}
                      min={it.date === todayEc() ? nowEcHHMM() : undefined}
                      onChange={(e) => setForm((f) => ({
                        ...f,
                        extraAppointments: f.extraAppointments.map((x, i) => i === idx ? { ...x, startTime: e.target.value } : x),
                      }))}
                      className="px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                    />
                  </div>
                  <input
                    type="text"
                    placeholder="Motivo (opcional)"
                    value={it.reason}
                    onChange={(e) => setForm((f) => ({
                      ...f,
                      extraAppointments: f.extraAppointments.map((x, i) => i === idx ? { ...x, reason: e.target.value } : x),
                    }))}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white"
                  />
                  <div>
                    <label className="text-xs font-medium text-slate-600 block mb-1">Servicios *</label>
                    <ServiceAutocomplete
                      services={services}
                      selectedIds={it.services || []}
                      onAdd={(id) => setForm((f) => ({
                        ...f,
                        extraAppointments: f.extraAppointments.map((x, i) =>
                          i === idx ? { ...x, services: (x.services || []).includes(id) ? x.services : [...(x.services || []), id] } : x
                        ),
                      }))}
                      onRemove={(id) => setForm((f) => ({
                        ...f,
                        extraAppointments: f.extraAppointments.map((x, i) =>
                          i === idx ? { ...x, services: (x.services || []).filter((s) => s !== id) } : x
                        ),
                      }))}
                    />
                    {(!it.services || it.services.length === 0) && (
                      <p className="text-[11px] text-rose-600 mt-1">Selecciona al menos un servicio.</p>
                    )}
                  </div>
                </div>
              ))}
              <button
                type="button"
                onClick={() => setForm((f) => ({
                  ...f,
                  extraAppointments: [...(f.extraAppointments || []), { date: '', startTime: '', reason: '', services: [] }],
                }))}
                className="w-full text-xs py-2 rounded-lg border border-dashed border-emerald-300 text-emerald-700 bg-emerald-50/40 hover:bg-emerald-100 cursor-pointer"
              >
                + Agregar otra cita (mismo paciente)
              </button>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white transition-colors"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50"
            >
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear Cita'}
            </button>
          </div>
          </form>

          {/* Panel lateral: citas agendadas en el horario seleccionado */}
          <SameSlotPanel
            date={form.date}
            startTime={form.startTime}
            excludeId={editing}
          />
        </div>
      </Modal>

      {/* Detail Modal */}
      <Modal
        isOpen={!!detailModal}
        onClose={() => setDetailModal(null)}
        title="Detalle de Cita"
        size="lg"
      >
        {detailModal && (
          <div className="space-y-4">
            {detailModal.isFirstVisit && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-2 text-amber-700 text-sm font-semibold uppercase tracking-wide">
                ✨ Paciente Nuevo
              </div>
            )}
            <div className="grid grid-cols-2 gap-4">
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Paciente</p>
                <p className="text-sm font-medium text-slate-800 mt-0.5">
                  {detailModal.patient?.firstName} {detailModal.patient?.lastName}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Cédula</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.patient?.cedula}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Doctor</p>
                <p className="text-sm font-medium text-slate-800 mt-0.5">
                  Dr. {detailModal.doctor?.name}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Especialidad</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.doctor?.specialty || '—'}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Fecha</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {formatLocalDate(detailModal.date)}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Horario</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.startTime} - {detailModal.endTime}
                </p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Estado</p>
                <span
                  className={`px-2.5 py-1 rounded-full text-xs font-medium ${
                    statusColors[detailModal.status] || statusColors.pendiente
                  }`}
                >
                  {statusLabels[detailModal.status] || 'Pendiente'}
                </span>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Teléfono</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.patient?.phone || '—'}
                </p>
              </div>
            </div>
            {detailModal.reason && (
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Motivo</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.reason}</p>
              </div>
            )}
            {detailModal.diagnosis && (
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Diagnóstico</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.diagnosis}</p>
              </div>
            )}
            {detailModal.treatment && (
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Tratamiento</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.treatment}</p>
              </div>
            )}
            {detailModal.services && detailModal.services.length > 0 && (
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium mb-1">Servicios</p>
                <ul className="text-sm text-slate-800 space-y-1">
                  {detailModal.services.map((s, i) => (
                    <li key={i} className="flex justify-between">
                      <span>{s.name}</span>
                      <span className="font-medium">
                        ${Number(s.price || 0).toFixed(2)}
                      </span>
                    </li>
                  ))}
                  <li className="flex justify-between border-t border-emerald-200 pt-1 font-bold">
                    <span>Total</span>
                    <span>
                      $
                      {detailModal.services
                        .reduce((s, x) => s + Number(x.price || 0), 0)
                        .toFixed(2)}
                    </span>
                  </li>
                </ul>
              </div>
            )}
            {detailModal.createdBy && (
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Registrado por</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.createdBy.name}
                  {detailModal.createdByRole
                    ? ` (${roleLabels[detailModal.createdByRole] || detailModal.createdByRole})`
                    : ''}
                </p>
              </div>
            )}
            {(detailModal.origin && detailModal.origin !== 'standalone') && (
              <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3">
                <p className="text-xs text-indigo-700 font-medium">Origen de la cita</p>
                <p className="text-sm text-slate-800 mt-0.5">
                  {detailModal.origin === 'referral' && (
                    <>Generada por derivación{detailModal.referral?.specialty ? ` — ${detailModal.referral.specialty}` : ''}</>
                  )}
                  {detailModal.origin === 'treatment' && (
                    <>Forma parte del tratamiento {detailModal.treatmentRef?.name ? `"${detailModal.treatmentRef.name}"` : ''}</>
                  )}
                </p>
              </div>
            )}
            {Array.isArray(detailModal.rescheduleHistory) && detailModal.rescheduleHistory.length > 0 && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                <p className="text-xs text-amber-700 font-medium mb-2">
                  Historial de reagendamientos ({detailModal.rescheduleHistory.length})
                </p>
                <ul className="space-y-2 text-xs text-slate-700">
                  {detailModal.rescheduleHistory.map((h, i) => (
                    <li key={i} className="border-l-2 border-amber-300 pl-2">
                      <div>
                        <span className="line-through text-slate-500">
                          {formatLocalDate(h.previousDate)} {h.previousStartTime}–{h.previousEndTime}
                        </span>{' '}
                        →{' '}
                        <span className="font-semibold">
                          {formatLocalDate(h.newDate)} {h.newStartTime}–{h.newEndTime}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-500">
                        por {h.rescheduledBy?.name || h.rescheduledByName || '—'}
                        {h.rescheduledByRole ? ` (${roleLabels[h.rescheduledByRole] || h.rescheduledByRole})` : ''}
                        {' • '}{fmtDateTime(h.at)}
                      </div>
                      {h.reason && <div className="italic text-slate-600">"{h.reason}"</div>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {hasRole('admin', 'cajero', 'enfermero') && detailModal.status !== 'completada' && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-3 space-y-2">
                <p className="text-xs font-medium text-slate-600 uppercase tracking-wide">Cambiar estado</p>
                <div className="flex flex-wrap gap-2">
                  {detailModal.status !== 'confirmada' && detailModal.status !== 'asistida' && detailModal.status !== 'no_asistio' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await api.post(`/appointments/${detailModal._id}/confirm`);
                          toast.success('Cita confirmada');
                          setDetailModal(null);
                          fetchAppointments();
                        } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-100 text-blue-700 hover:bg-blue-200 border-none cursor-pointer"
                    >Confirmar</button>
                  )}
                  {canCharge && detailModal.status !== 'asistida' && (
                    <button
                      type="button"
                      onClick={() => {
                        setAssignModal({ appointment: detailModal });
                        setDetailModal(null);
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-none cursor-pointer"
                    >Recibir (asistió + cobro)</button>
                  )}
                  {detailModal.status !== 'no_asistio' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await api.post(`/appointments/${detailModal._id}/no-show`);
                          toast.success('Marcada como no asistió');
                          setDetailModal(null);
                          fetchAppointments();
                        } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-rose-100 text-rose-700 hover:bg-rose-200 border-none cursor-pointer"
                    >No asistió</button>
                  )}
                </div>
              </div>
            )}
            {!isCallCenter && (
              <div className="flex justify-end pt-2">
                <button
                  onClick={() => downloadPdf(detailModal._id)}
                  className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm bg-emerald-600 hover:bg-emerald-700 text-white border-none cursor-pointer"
                >
                  <HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar PDF
                </button>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Modal de aviso de fin de cita (cronómetro) */}
      <Modal
        isOpen={!!timeUpModal}
        onClose={() => setTimeUpModal(null)}
        title="⏰ Tiempo de consulta finalizado"
        size="md"
      >
        {timeUpModal && (
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              El tiempo programado para la consulta de{' '}
              <span className="font-bold">
                {timeUpModal.patient?.firstName} {timeUpModal.patient?.lastName}
              </span>{' '}
              ha terminado.
            </p>
            <p className="text-xs text-slate-500">
              Programada: {timeUpModal.startTime} – {timeUpModal.endTime}
            </p>
            <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-amber-800 text-sm">
              Tiempo transcurrido:{' '}
              <span className="font-mono font-bold">
                {fmtSeconds(elapsedSeconds(timeUpModal))}
              </span>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button
                onClick={() => setTimeUpModal(null)}
                className="px-4 py-2 rounded-xl text-sm border border-slate-200 bg-white hover:bg-slate-50 cursor-pointer"
              >
                Continuar consulta
              </button>
              <button
                onClick={() => endConsultation(timeUpModal)}
                className="px-4 py-2 rounded-xl text-sm bg-emerald-600 hover:bg-emerald-700 text-white border-none cursor-pointer"
              >
                Finalizar y completar
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* Flujo de recepción: asistencia → cobro → derivación (doctor o enfermería) */}
      {assignModal && (
        <AttendChargeModal
          appointment={assignModal.appointment}
          doctors={doctors}
          onClose={() => setAssignModal(null)}
          onDone={fetchAppointments}
        />
      )}

      {nurseFinish && (
        <NurseFinishModal
          appointment={nurseFinish}
          onClose={() => setNurseFinish(null)}
          onDone={fetchAppointments}
        />
      )}
    </div>
  );
}

// Buscador autocompletable de servicios. Permite escribir y elegir entre coincidencias,
// y muestra las ya seleccionadas como chips removibles.
function ServiceAutocomplete({ services, selectedIds, onAdd, onRemove }) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const available = services.filter((s) => !selectedIds.includes(s._id));
    if (!q) return available.slice(0, 15);
    return available
      .filter((s) =>
        (s.name || '').toLowerCase().includes(q) ||
        (s.code || '').toLowerCase().includes(q)
      )
      .slice(0, 15);
  }, [query, services, selectedIds]);

  const selectedServices = selectedIds
    .map((id) => services.find((s) => s._id === id))
    .filter(Boolean);

  return (
    <div className="space-y-2">
      <div className="relative">
        <HiOutlineMagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 180)}
          placeholder={services.length === 0 ? 'No hay servicios disponibles. Créalos en Inventario.' : 'Buscar servicio por nombre o código...'}
          className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
        />
        {open && matches.length > 0 && (
          <div className="absolute z-30 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-emerald-100 rounded-xl shadow-lg">
            {matches.map((s) => (
              <button
                type="button"
                key={s._id}
                onMouseDown={(e) => { e.preventDefault(); onAdd(s._id); setQuery(''); setOpen(false); }}
                className="w-full text-left px-4 py-2 text-sm hover:bg-emerald-50 cursor-pointer bg-white border-none border-b border-emerald-50 flex items-center justify-between"
              >
                <span className="flex-1">
                  <span className="font-medium text-slate-800">{s.name}</span>
                  {s.category === 'programa' && (
                    <span className="ml-2 text-[10px] text-purple-600 font-semibold">(programa)</span>
                  )}
                  {s.excludeFromFirstVisit && (
                    <span className="ml-2 text-[10px] text-slate-400">(recurrente)</span>
                  )}
                </span>
                <span className="text-xs text-slate-500">${Number(s.salePrice).toFixed(2)}</span>
              </button>
            ))}
          </div>
        )}
        {open && query.trim() && matches.length === 0 && (
          <div className="absolute z-30 left-0 right-0 mt-1 bg-white border border-emerald-100 rounded-xl shadow-lg px-4 py-2 text-xs text-slate-400">
            Sin coincidencias
          </div>
        )}
      </div>
      {selectedServices.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedServices.map((s) => (
            <span
              key={s._id}
              className="inline-flex items-center gap-1.5 bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded-full"
            >
              {s.name}
              <span className="text-emerald-600">${Number(s.salePrice).toFixed(2)}</span>
              <button
                type="button"
                onClick={() => onRemove(s._id)}
                className="text-emerald-700 hover:text-emerald-900 bg-transparent border-none cursor-pointer text-base leading-none"
                title="Quitar"
              >×</button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// SameSlotPanel ahora vive en components/SameSlotPanel.jsx y se reutiliza también
// desde el modal de citas del chat.
