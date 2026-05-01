import { useState, useEffect } from 'react';
import api from '../api/axios';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { HiOutlinePlus, HiOutlinePencil, HiOutlineTrash, HiOutlineEye } from 'react-icons/hi2';

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
};

export default function Appointments() {
  const { hasRole } = useAuth();
  const canWrite = hasRole('admin', 'cajero');
  const [appointments, setAppointments] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [patients, setPatients] = useState([]);
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

  useEffect(() => { fetchDoctors(); fetchPatients(); }, []);
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
    });
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/appointments/${editing}`, form);
        toast.success('Cita actualizada');
      } else {
        await api.post('/appointments', form);
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
            {view === 'today' ? 'Ver Todas' : 'Solo Hoy'}
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
                      {new Date(apt.date).toLocaleDateString('es-EC')}
                    </td>
                    <td className="px-6 py-3.5 text-sm text-slate-800 font-medium">{apt.startTime} - {apt.endTime}</td>
                    <td className="px-6 py-3.5 text-sm text-slate-800">
                      {apt.patient?.firstName} {apt.patient?.lastName}
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
                <p className="text-sm text-slate-800 mt-0.5">{new Date(detailModal.date).toLocaleDateString('es-EC')}</p>
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
          </div>
        )}
      </Modal>
    </div>
  );
}
