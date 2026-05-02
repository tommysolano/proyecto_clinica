import { useState, useEffect } from 'react';
import api from '../api/axios';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { HiOutlinePlus, HiOutlinePencil, HiOutlineTrash, HiOutlineEye, HiOutlineDocumentArrowDown } from 'react-icons/hi2';

const statusColors = {
  programada: 'bg-blue-100 text-blue-700',
  confirmada: 'bg-emerald-100 text-emerald-700',
  en_curso: 'bg-amber-100 text-amber-700',
  completada: 'bg-slate-100 text-slate-700',
  cancelada: 'bg-red-100 text-red-700',
  no_asistio: 'bg-orange-100 text-orange-700',
};

const statusLabels = {
  programada: 'Programada',
  confirmada: 'Confirmada',
  en_curso: 'En curso',
  completada: 'Completada',
  cancelada: 'Cancelada',
  no_asistio: 'No asistió',
};

const emptyForm = {
  patient: '', doctor: '', date: '', startTime: '', endTime: '',
  status: 'programada', reason: '', notes: '', diagnosis: '', treatment: '',
  services: [],
};

const roleLabels = {
  admin: 'Administrador',
  cajero: 'Cajero',
  doctor: 'Doctor',
  contabilidad: 'Contabilidad',
  call_center: 'Call Center',
};

// Formatea una fecha ISO usando los componentes de fecha (sin convertir a UTC),
// para que el día mostrado sea siempre el día guardado.
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

export default function Appointments() {
  const { hasRole } = useAuth();
  const canWrite = hasRole('admin', 'cajero', 'call_center');
  const [appointments, setAppointments] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [patients, setPatients] = useState([]);
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modalOpen, setModalOpen] = useState(false);
  const [detailModal, setDetailModal] = useState(null);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [filter, setFilter] = useState({ startDate: '', endDate: '', status: '' });
  const [view, setView] = useState('list'); // 'list' | 'today'

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
      const res = await api.get('/appointments', { params });
      setAppointments(res.data);
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
    } catch {}
  };

  const fetchPatients = async () => {
    try {
      const res = await api.get('/patients', { params: { limit: 1000 } });
      setPatients(res.data.patients);
    } catch {}
  };

  const fetchServices = async () => {
    try {
      // Servicios = productos de categoría 'servicio' o ilimitados
      const res = await api.get('/products', { params: { limit: 500 } });
      const list = (res.data || []).filter(
        (p) => p.active !== false && (p.category === 'servicio' || p.unlimited === true)
      );
      setServices(list);
    } catch {}
  };

  useEffect(() => { fetchDoctors(); fetchPatients(); fetchServices(); }, []);
  useEffect(() => { fetchAppointments(); }, [view, filter]);

  const openNew = () => {
    setEditing(null);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const openEdit = (apt) => {
    setEditing(apt._id);
    setForm({
      patient: apt.patient?._id || '',
      doctor: apt.doctor?._id || '',
      date: apt.date ? apt.date.split('T')[0] : '',
      startTime: apt.startTime,
      endTime: apt.endTime,
      status: apt.status,
      reason: apt.reason || '',
      notes: apt.notes || '',
      diagnosis: apt.diagnosis || '',
      treatment: apt.treatment || '',
      services: (apt.services || []).map((s) => (s.product?._id || s.product || s._id)).filter(Boolean),
    });
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Validar horarios en cliente
    if (form.startTime && form.endTime && form.endTime <= form.startTime) {
      toast.error('La hora de fin debe ser posterior a la hora de inicio');
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

  const handleDelete = async (id) => {
    if (!window.confirm('¿Cancelar esta cita?')) return;
    try {
      await api.delete(`/appointments/${id}`);
      toast.success('Cita cancelada');
      fetchAppointments();
    } catch {
      toast.error('Error al cancelar');
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
      const res = await api.get('/reports/appointments.xlsx', { params, responseType: 'blob' });
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
      setDetailModal(res.data);
    } catch {
      toast.error('Error al cargar detalle');
    }
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
              view === 'today' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-white text-slate-600 border-slate-200 hover:bg-emerald-50'
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

      {/* Filters */}
      {view === 'list' && (
        <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 mb-6 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
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
          </div>
        </div>
      )}

      {/* List */}
      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-emerald-50/50 border-b border-emerald-100">
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Fecha</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Hora</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Paciente</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">Doctor</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Estado</th>
                <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="6" className="text-center py-10 text-slate-500">Cargando...</td></tr>
              ) : appointments.length === 0 ? (
                <tr><td colSpan="6" className="text-center py-10 text-slate-500">No se encontraron citas</td></tr>
              ) : (
                appointments.map((apt) => (
                  <tr key={apt._id} className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors">
                    <td className="px-6 py-3.5 text-sm text-slate-600">
                      {formatLocalDate(apt.date)}
                    </td>
                    <td className="px-6 py-3.5 text-sm text-slate-800 font-medium">{apt.startTime} - {apt.endTime}</td>
                    <td className="px-6 py-3.5 text-sm text-slate-800">
                      <div className="flex items-center gap-2">
                        <span>{apt.patient?.firstName} {apt.patient?.lastName}</span>
                        {apt.isFirstVisit && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 uppercase">
                            Nuevo
                          </span>
                        )}
                      </div>
                      {apt.createdBy && (
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Por: {apt.createdBy.name}
                          {apt.createdByRole ? ` (${roleLabels[apt.createdByRole] || apt.createdByRole})` : ''}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-3.5 text-sm text-slate-600 hidden md:table-cell">
                      Dr. {apt.doctor?.name}
                    </td>
                    <td className="px-6 py-3.5">
                      <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[apt.status]}`}>
                        {statusLabels[apt.status]}
                      </span>
                    </td>
                    <td className="px-6 py-3.5 text-right">
                      <button onClick={() => openDetail(apt._id)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors">
                        <HiOutlineEye className="w-4 h-4" />
                      </button>
                      <button onClick={() => downloadPdf(apt._id)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors" title="Descargar PDF">
                        <HiOutlineDocumentArrowDown className="w-4 h-4" />
                      </button>
                      <button onClick={() => openEdit(apt)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors">
                        <HiOutlinePencil className="w-4 h-4" />
                      </button>
                      {canWrite && (
                        <button onClick={() => handleDelete(apt._id)} className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer transition-colors">
                          <HiOutlineTrash className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create/Edit Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar Cita' : 'Nueva Cita'} size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Paciente *</label>
              <select name="patient" value={form.patient} onChange={handleChange} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
                <option value="">Seleccionar paciente</option>
                {patients.map(p => (
                  <option key={p._id} value={p._id}>{p.firstName} {p.lastName} - {p.cedula}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Doctor *</label>
              <select name="doctor" value={form.doctor} onChange={handleChange} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
                <option value="">Seleccionar doctor</option>
                {doctors.map(d => (
                  <option key={d._id} value={d._id}>Dr. {d.name} - {d.specialty}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Fecha *</label>
              <input name="date" type="date" value={form.date} onChange={handleChange} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Estado</label>
              <select name="status" value={form.status} onChange={handleChange} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
                {Object.entries(statusLabels).map(([k, v]) => (
                  <option key={k} value={k}>{v}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Hora inicio *</label>
              <input name="startTime" type="time" value={form.startTime} onChange={handleChange} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Hora fin *</label>
              <input name="endTime" type="time" value={form.endTime} onChange={handleChange} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Motivo de consulta</label>
            <textarea name="reason" value={form.reason} onChange={handleChange} rows={2} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Servicios</label>
            <div className="border border-slate-200 rounded-xl bg-slate-50/50 max-h-48 overflow-y-auto p-2">
              {services.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-3">
                  No hay servicios disponibles. Créalos en Inventario marcándolos como categoría "Servicio" o "ilimitado".
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
                      <span className="flex-1">{s.name}</span>
                      <span className="text-xs text-slate-500">${Number(s.salePrice).toFixed(2)}</span>
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
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Diagnóstico</label>
                <textarea name="diagnosis" value={form.diagnosis} onChange={handleChange} rows={2} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">Tratamiento</label>
                <textarea name="treatment" value={form.treatment} onChange={handleChange} rows={2} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none" />
              </div>
            </>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Notas</label>
            <textarea name="notes" value={form.notes} onChange={handleChange} rows={2} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none" />
          </div>
          <div className="flex justify-end gap-3 pt-3">
            <button type="button" onClick={() => setModalOpen(false)} className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50">
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear Cita'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Detail Modal */}
      <Modal isOpen={!!detailModal} onClose={() => setDetailModal(null)} title="Detalle de Cita" size="lg">
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
                <p className="text-sm font-medium text-slate-800 mt-0.5">{detailModal.patient?.firstName} {detailModal.patient?.lastName}</p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Cédula</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.patient?.cedula}</p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Doctor</p>
                <p className="text-sm font-medium text-slate-800 mt-0.5">Dr. {detailModal.doctor?.name}</p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Especialidad</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.doctor?.specialty || '—'}</p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Fecha</p>
                <p className="text-sm text-slate-800 mt-0.5">{formatLocalDate(detailModal.date)}</p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Horario</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.startTime} - {detailModal.endTime}</p>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Estado</p>
                <span className={`px-2.5 py-1 rounded-full text-xs font-medium ${statusColors[detailModal.status]}`}>
                  {statusLabels[detailModal.status]}
                </span>
              </div>
              <div className="bg-emerald-50/50 rounded-xl p-3">
                <p className="text-xs text-emerald-600 font-medium">Teléfono</p>
                <p className="text-sm text-slate-800 mt-0.5">{detailModal.patient?.phone || '—'}</p>
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
                      <span className="font-medium">${Number(s.price || 0).toFixed(2)}</span>
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
    </div>
  );
}
