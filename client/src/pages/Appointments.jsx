import { useState, useEffect, useRef, useMemo } from 'react';
import api from '../api/axios';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineEye,
  HiOutlineDocumentArrowDown,
  HiOutlinePlay,
  HiOutlineStop,
  HiOutlineMagnifyingGlass,
} from 'react-icons/hi2';

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
  doctor: '',
  room: '',
  date: '',
  startTime: '',
  endTime: '',
  status: 'pendiente',
  reason: '',
  notes: '',
  diagnosis: '',
  treatment: '',
  services: [],
  clinic: '',
  paidInAdvance: false,
  advanceAmount: 0,
};

const roleLabels = {
  admin: 'Administrador',
  cajero: 'Cajero',
  doctor: 'Doctor',
  contabilidad: 'Contabilidad',
  call_center: 'Call Center',
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

// Convierte HH:MM a minutos
const hhmmToMin = (s) => {
  if (!s) return null;
  const m = String(s).match(/^(\d{2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
};

export default function Appointments() {
  const { user, role, hasRole, activeClinic, clinics } = useAuth();
  const canWrite = hasRole('admin', 'cajero', 'call_center');
  const isAdmin = hasRole('admin') || user?.isSuperAdmin;
  const isDoctor = role === 'doctor';
  const isCallCenter = role === 'call_center';

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
  const [filter, setFilter] = useState({
    startDate: '',
    endDate: '',
    status: '',
    isFirstVisit: '',
    room: '',
    service: '',
    timeFrom: '',
    timeTo: '',
  });
  const [view, setView] = useState('list'); // 'list' | 'today'
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
      if (view === 'today') {
        const today = new Date().toISOString().split('T')[0];
        params.startDate = today;
        params.endDate = today;
      } else {
        if (filter.startDate) params.startDate = filter.startDate;
        if (filter.endDate) params.endDate = filter.endDate;
        if (filter.status) params.status = filter.status;
      }
      if (filter.isFirstVisit) params.isFirstVisit = filter.isFirstVisit;
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
      const list = (res.data || []).filter(
        (p) => p.active !== false && (p.category === 'servicio' || p.unlimited === true)
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
  }, [view, filter]);

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
    if (isAdmin) return true;
    if (isDoctor && String(apt.doctor?._id || apt.doctor) === String(user?.id)) return true;
    return String(apt.createdBy?._id || apt.createdBy) === String(user?.id);
  };

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
    if (form.startTime && form.endTime && form.endTime <= form.startTime) {
      toast.error('La hora de fin debe ser posterior a la hora de inicio');
      return;
    }
    if (!form.patient) {
      toast.error('Selecciona un paciente');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        services: (form.services || []).map((id) => ({ product: id })),
      };
      if (editing) {
        await api.put(`/appointments/${editing}`, payload);
        toast.success('Cita actualizada');
      } else {
        await api.post('/appointments', payload);
        toast.success('Cita creada');
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

  const toggleService = (id) => {
    setForm((prev) => {
      const exists = prev.services.includes(id);
      return {
        ...prev,
        services: exists ? prev.services.filter((s) => s !== id) : [...prev.services, id],
      };
    });
  };

  const downloadPdf = async (id) => {
    try {
      const res = await api.get(`/appointments/${id}/pdf`, { responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `cita_${id}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Error al descargar PDF');
    }
  };

  const exportExcel = async () => {
    try {
      const params = {};
      if (view === 'today') {
        const today = new Date().toISOString().split('T')[0];
        params.startDate = today;
        params.endDate = today;
      } else {
        if (filter.startDate) params.startDate = filter.startDate;
        if (filter.endDate) params.endDate = filter.endDate;
        if (filter.status) params.status = filter.status;
      }
      const res = await api.get('/reports/appointments.xlsx', {
        params,
        responseType: 'blob',
      });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = `citas_${Date.now()}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      toast.error('Error al exportar');
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

  // Aplica filtros en el cliente para servicio/consultorio/rango horario.
  const filteredAppointments = useMemo(() => {
    return appointments.filter((apt) => {
      if (filter.service) {
        const has = (apt.services || []).some(
          (s) => String(s.product?._id || s.product) === String(filter.service)
        );
        if (!has) return false;
      }
      if (filter.room) {
        const r = apt.room?._id || apt.room;
        if (String(r) !== String(filter.room)) return false;
      }
      if (filter.timeFrom && apt.startTime && apt.startTime < filter.timeFrom) return false;
      if (filter.timeTo && apt.startTime && apt.startTime > filter.timeTo) return false;
      return true;
    });
  }, [appointments, filter.service, filter.room, filter.timeFrom, filter.timeTo]);

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
          <h1 className="text-2xl font-bold text-slate-800">Citas Médicas</h1>
          <p className="text-sm text-slate-500 mt-1">Agenda y seguimiento de consultas</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setView(view === 'today' ? 'list' : 'today')}
            className={`px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer border transition-colors ${
              view === 'today'
                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                : 'bg-white text-slate-600 border-slate-200 hover:bg-emerald-50'
            }`}
          >
            {view === 'today' ? 'Solo Hoy' : 'Ver Todas'}
          </button>
          <button
            onClick={exportExcel}
            className="px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer border bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50"
          >
            Excel
          </button>
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

      {view === 'list' && (
        <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 mb-6 p-4 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
            <input
              type="date"
              value={filter.startDate}
              onChange={(e) => setFilter({ ...filter, startDate: e.target.value })}
              className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              placeholder="Desde"
            />
            <input
              type="date"
              value={filter.endDate}
              onChange={(e) => setFilter({ ...filter, endDate: e.target.value })}
              className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              placeholder="Hasta"
            />
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
            <select
              value={filter.service}
              onChange={(e) => setFilter({ ...filter, service: e.target.value })}
              className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50"
            >
              <option value="">Todos los servicios</option>
              {services.map((s) => <option key={s._id} value={s._id}>{s.name}</option>)}
            </select>
            <select
              value={filter.room}
              onChange={(e) => setFilter({ ...filter, room: e.target.value })}
              className="px-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-slate-50/50"
            >
              <option value="">Todos los consultorios</option>
              {rooms.map((r) => <option key={r._id} value={r._id}>{r.name}</option>)}
            </select>
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
          </div>
          <div className="flex items-center justify-between text-xs text-slate-500">
            <span>Total filtrado: <strong className="text-slate-800">{filteredAppointments.length}</strong> citas</span>
            {(filter.service || filter.room || filter.timeFrom || filter.timeTo || filter.status || filter.isFirstVisit) && (
              <button
                onClick={() => setFilter({ startDate: '', endDate: '', status: '', isFirstVisit: '', room: '', service: '', timeFrom: '', timeTo: '' })}
                className="text-emerald-600 hover:underline border-none bg-transparent cursor-pointer"
              >Limpiar filtros</button>
            )}
          </div>
        </div>
      )}

      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
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
                  Doctor
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
                filteredAppointments.map((apt) => {
                  const editable = canEdit(apt);
                  const showDoctorTimer =
                    isDoctor &&
                    String(apt.doctor?._id || apt.doctor) === String(user?.id) &&
                    apt.status !== 'completada';
                  const inProgress =
                    apt.consultationStartedAt && !apt.consultationEndedAt;
                  return (
                    <tr
                      key={apt._id}
                      className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors"
                    >
                      <td className="px-6 py-3.5 text-sm text-slate-600">
                        {formatLocalDate(apt.date)}
                      </td>
                      <td className="px-6 py-3.5 text-sm text-slate-800 font-medium">
                        {apt.startTime} - {apt.endTime}
                        {inProgress && (
                          <div className="text-[11px] text-amber-700 font-mono mt-0.5">
                            ⏱ {fmtSeconds(elapsedSeconds(apt))}
                          </div>
                        )}
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
                        Dr. {apt.doctor?.name}
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
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create/Edit Modal */}
      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar Cita' : 'Nueva Cita'}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {/* Selector de consultorio médico para call_center con múltiples consultorios */}
          {isCallCenter && (clinics?.length || 0) > 1 && (
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Consultorio médico destino *
              </label>
              <select
                name="clinic"
                value={form.clinic}
                onChange={handleChange}
                required
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              >
                <option value="">Seleccionar consultorio médico</option>
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
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Doctor *
              </label>
              <select
                name="doctor"
                value={form.doctor}
                onChange={handleChange}
                required
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              >
                <option value="">Seleccionar doctor</option>
                {doctors.map((d) => (
                  <option key={d._id} value={d._id}>
                    Dr. {d.name} - {d.specialty}
                  </option>
                ))}
              </select>
            </div>
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
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">
                Fecha *
              </label>
              <input
                name="date"
                type="date"
                value={form.date}
                onChange={handleChange}
                required
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Inicio *
                </label>
                <input
                  name="startTime"
                  type="time"
                  value={form.startTime}
                  onChange={handleChange}
                  required
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Fin *
                </label>
                <input
                  name="endTime"
                  type="time"
                  value={form.endTime}
                  onChange={handleChange}
                  required
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50"
                />
              </div>
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
                <input
                  type="number"
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
              Servicios
            </label>
            <div className="border border-slate-200 rounded-xl bg-slate-50/50 max-h-48 overflow-y-auto p-2">
              {services.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-3">
                  No hay servicios disponibles. Créalos en Inventario.
                </p>
              ) : (
                services.map((s) => {
                  const checked = form.services.includes(s._id);
                  return (
                    <label
                      key={s._id}
                      className={`flex items-center gap-2 px-2 py-1.5 rounded-lg cursor-pointer text-sm ${
                        checked ? 'bg-emerald-100 text-emerald-800' : 'hover:bg-emerald-50'
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleService(s._id)}
                        className="w-4 h-4 accent-emerald-600"
                      />
                      <span className="flex-1">
                        {s.name}
                        {s.maxAppointmentsPerDay > 0 && (
                          <span className="ml-1 text-[10px] text-amber-600">
                            (cupo {s.maxAppointmentsPerDay}/día)
                          </span>
                        )}
                        {s.excludeFromFirstVisit && (
                          <span className="ml-1 text-[10px] text-slate-400">
                            (recurrente)
                          </span>
                        )}
                      </span>
                      <span className="text-xs text-slate-500">
                        ${Number(s.salePrice).toFixed(2)}
                      </span>
                    </label>
                  );
                })
              )}
            </div>
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
          {editing && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Diagnóstico
                </label>
                <textarea
                  name="diagnosis"
                  value={form.diagnosis}
                  onChange={handleChange}
                  rows={2}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Tratamiento
                </label>
                <textarea
                  name="treatment"
                  value={form.treatment}
                  onChange={handleChange}
                  rows={2}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none"
                />
              </div>
            </>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Notas</label>
            <textarea
              name="notes"
              value={form.notes}
              onChange={handleChange}
              rows={2}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none"
            />
          </div>
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
            {hasRole('admin', 'cajero', 'call_center', 'enfermero') && detailModal.status !== 'completada' && (
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
                  {detailModal.status !== 'asistida' && (
                    <button
                      type="button"
                      onClick={async () => {
                        try {
                          await api.post(`/appointments/${detailModal._id}/attended`);
                          toast.success('Marcada como asistida');
                          setDetailModal(null);
                          fetchAppointments();
                        } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
                      }}
                      className="px-3 py-1.5 rounded-lg text-xs font-medium bg-emerald-100 text-emerald-700 hover:bg-emerald-200 border-none cursor-pointer"
                    >Asistió</button>
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
            <div className="flex justify-end pt-2">
              <button
                onClick={() => downloadPdf(detailModal._id)}
                className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm bg-emerald-600 hover:bg-emerald-700 text-white border-none cursor-pointer"
              >
                <HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar PDF
              </button>
            </div>
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
    </div>
  );
}
