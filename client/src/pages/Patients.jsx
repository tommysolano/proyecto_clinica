import { useState, useEffect } from 'react';
import api from '../api/axios';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { HiOutlinePlus, HiOutlinePencil, HiOutlineTrash, HiOutlineMagnifyingGlass } from 'react-icons/hi2';

const emptyForm = {
  cedula: '', firstName: '', lastName: '', email: '', phone: '', whatsapp: '',
  birthDate: '', gender: '', address: '', bloodType: '', allergies: '', notes: '',
};

export default function Patients() {
  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchPatients = async () => {
    try {
      const res = await api.get('/patients', { params: { search, page, limit: 15 } });
      setPatients(res.data.patients);
      setTotalPages(res.data.pages);
    } catch {
      toast.error('Error al cargar pacientes');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchPatients(); }, [search, page]);

  const openNew = () => {
    setEditing(null);
    setForm(emptyForm);
    setModalOpen(true);
  };

  const openEdit = (patient) => {
    setEditing(patient._id);
    setForm({
      ...emptyForm,
      ...patient,
      birthDate: patient.birthDate ? patient.birthDate.split('T')[0] : '',
    });
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/patients/${editing}`, form);
        toast.success('Paciente actualizado');
      } else {
        await api.post('/patients', form);
        toast.success('Paciente creado');
      }
      setModalOpen(false);
      fetchPatients();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('¿Estás seguro de eliminar este paciente?')) return;
    try {
      await api.delete(`/patients/${id}`);
      toast.success('Paciente eliminado');
      fetchPatients();
    } catch {
      toast.error('Error al eliminar');
    }
  };

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  return (
    <div>
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Pacientes</h1>
          <p className="text-sm text-slate-500 mt-1">Gestión de pacientes registrados</p>
        </div>
        <button
          onClick={openNew}
          className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50 transition-all"
        >
          <HiOutlinePlus className="w-5 h-5" /> Nuevo Paciente
        </button>
      </div>

      {/* Search */}
      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 mb-6">
        <div className="p-4">
          <div className="relative">
            <HiOutlineMagnifyingGlass className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
            <input
              type="text"
              placeholder="Buscar por nombre, cédula o teléfono..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-full pl-11 pr-4 py-3 border border-slate-200 rounded-xl bg-slate-50/50 focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 outline-none text-sm"
            />
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-emerald-50/50 border-b border-emerald-100">
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Cédula</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Nombre</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden md:table-cell">Teléfono</th>
                <th className="text-left px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider hidden lg:table-cell">Email</th>
                <th className="text-right px-6 py-3.5 text-xs font-semibold text-emerald-700 uppercase tracking-wider">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="5" className="text-center py-10 text-slate-500">Cargando...</td></tr>
              ) : patients.length === 0 ? (
                <tr><td colSpan="5" className="text-center py-10 text-slate-500">No se encontraron pacientes</td></tr>
              ) : (
                patients.map((p) => (
                  <tr key={p._id} className="border-b border-emerald-50 hover:bg-emerald-50/30 transition-colors">
                    <td className="px-6 py-3.5 text-sm text-slate-600">{p.cedula}</td>
                    <td className="px-6 py-3.5 text-sm font-medium text-slate-800">{p.firstName} {p.lastName}</td>
                    <td className="px-6 py-3.5 text-sm text-slate-600 hidden md:table-cell">{p.phone || '—'}</td>
                    <td className="px-6 py-3.5 text-sm text-slate-600 hidden lg:table-cell">{p.email || '—'}</td>
                    <td className="px-6 py-3.5 text-right">
                      <button onClick={() => openEdit(p)} className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer transition-colors">
                        <HiOutlinePencil className="w-4 h-4" />
                      </button>
                      <button onClick={() => handleDelete(p._id)} className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer ml-1 transition-colors">
                        <HiOutlineTrash className="w-4 h-4" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 px-6 py-4 border-t border-emerald-100">
            <button
              disabled={page <= 1}
              onClick={() => setPage(p => p - 1)}
              className="px-4 py-2 rounded-xl text-sm border border-slate-200 disabled:opacity-50 cursor-pointer bg-white hover:bg-emerald-50 transition-colors"
            >
              Anterior
            </button>
            <span className="text-sm text-slate-500">Página {page} de {totalPages}</span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage(p => p + 1)}
              className="px-4 py-2 rounded-xl text-sm border border-slate-200 disabled:opacity-50 cursor-pointer bg-white hover:bg-emerald-50 transition-colors"
            >
              Siguiente
            </button>
          </div>
        )}
      </div>

      {/* Modal */}
      <Modal isOpen={modalOpen} onClose={() => setModalOpen(false)} title={editing ? 'Editar Paciente' : 'Nuevo Paciente'} size="lg">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Cédula *</label>
              <input name="cedula" value={form.cedula} onChange={handleChange} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Género</label>
              <select name="gender" value={form.gender} onChange={handleChange} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
                <option value="">Seleccionar</option>
                <option value="masculino">Masculino</option>
                <option value="femenino">Femenino</option>
                <option value="otro">Otro</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Nombres *</label>
              <input name="firstName" value={form.firstName} onChange={handleChange} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Apellidos *</label>
              <input name="lastName" value={form.lastName} onChange={handleChange} required className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Email</label>
              <input name="email" type="email" value={form.email} onChange={handleChange} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Teléfono</label>
              <input name="phone" value={form.phone} onChange={handleChange} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">WhatsApp</label>
              <input name="whatsapp" value={form.whatsapp} onChange={handleChange} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Fecha de nacimiento</label>
              <input name="birthDate" type="date" value={form.birthDate} onChange={handleChange} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">Tipo de sangre</label>
              <select name="bloodType" value={form.bloodType} onChange={handleChange} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50">
                <option value="">Seleccionar</option>
                {['A+','A-','B+','B-','AB+','AB-','O+','O-'].map(bt => (
                  <option key={bt} value={bt}>{bt}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Dirección</label>
            <input name="address" value={form.address} onChange={handleChange} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Alergias</label>
            <textarea name="allergies" value={form.allergies} onChange={handleChange} rows={2} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">Notas</label>
            <textarea name="notes" value={form.notes} onChange={handleChange} rows={2} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm outline-none focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500 bg-slate-50/50 resize-none" />
          </div>
          <div className="flex justify-end gap-3 pt-3">
            <button type="button" onClick={() => setModalOpen(false)} className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white transition-colors">
              Cancelar
            </button>
            <button type="submit" disabled={saving} className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50">
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear Paciente'}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
