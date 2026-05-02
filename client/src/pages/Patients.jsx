import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/axios';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineMagnifyingGlass,
  HiOutlineEye,
} from 'react-icons/hi2';

const emptyForm = {
  cedula: '',
  firstName: '',
  lastName: '',
  email: '',
  phone: '',
  whatsapp: '',
  birthDate: '',
  age: '',
  gender: '',
  address: '',
  notes: '',
};

export default function Patients() {
  const { hasRole } = useAuth();
  const canWrite = hasRole('admin', 'cajero', 'call_center');
  const canDelete = hasRole('admin');

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

  useEffect(() => {
    fetchPatients();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, page]);

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
      age: patient.age ?? '',
    });
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      const payload = {
        ...form,
        age: form.age === '' ? undefined : Number(form.age),
      };
      if (editing) {
        await api.put(`/patients/${editing}`, payload);
        toast.success('Paciente actualizado');
      } else {
        await api.post('/patients', payload);
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
    if (!window.confirm('¿Eliminar este paciente?')) return;
    try {
      await api.delete(`/patients/${id}`);
      toast.success('Paciente eliminado');
      fetchPatients();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al eliminar');
    }
  };

  const handleChange = (e) => setForm({ ...form, [e.target.name]: e.target.value });

  return (
    <div className="p-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-6">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Pacientes</h1>
          <p className="text-sm text-slate-500 mt-1">Gestión de pacientes registrados</p>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <button
              onClick={async () => {
                try {
                  const res = await api.get('/reports/patients.xlsx', { responseType: 'blob' });
                  const url = URL.createObjectURL(res.data);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = `pacientes_${Date.now()}.xlsx`;
                  a.click();
                  URL.revokeObjectURL(url);
                } catch {
                  toast.error('Error al exportar');
                }
              }}
              className="flex items-center gap-2 bg-white border border-emerald-200 text-emerald-700 hover:bg-emerald-50 px-4 py-2.5 rounded-xl text-sm font-medium cursor-pointer"
            >
              Excel
            </button>
            <button
              onClick={openNew}
              className="flex items-center gap-2 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white px-5 py-2.5 rounded-xl text-sm font-medium cursor-pointer border-none shadow-lg shadow-emerald-200/50"
            >
              <HiOutlinePlus className="w-5 h-5" /> Nuevo Paciente
            </button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-emerald-100 mb-6 p-4">
        <div className="relative">
          <HiOutlineMagnifyingGlass className="absolute left-3.5 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400" />
          <input
            type="text"
            placeholder="Buscar por nombre, cédula o teléfono..."
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="w-full pl-11 pr-4 py-3 border border-slate-200 rounded-xl bg-slate-50/50 outline-none text-sm"
          />
        </div>
      </div>

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
                <tr>
                  <td colSpan="5" className="text-center py-10 text-slate-500">
                    Cargando...
                  </td>
                </tr>
              ) : patients.length === 0 ? (
                <tr>
                  <td colSpan="5" className="text-center py-10 text-slate-500">
                    No se encontraron pacientes
                  </td>
                </tr>
              ) : (
                patients.map((p) => (
                  <tr key={p._id} className="border-b border-emerald-50 hover:bg-emerald-50/30">
                    <td className="px-6 py-3.5 text-sm text-slate-600">{p.cedula}</td>
                    <td className="px-6 py-3.5 text-sm font-medium text-slate-800">
                      {p.firstName} {p.lastName}
                    </td>
                    <td className="px-6 py-3.5 text-sm text-slate-600 hidden md:table-cell">
                      {p.phone || '—'}
                    </td>
                    <td className="px-6 py-3.5 text-sm text-slate-600 hidden lg:table-cell">
                      {p.email || '—'}
                    </td>
                    <td className="px-6 py-3.5 text-right">
                      <Link
                        to={`/patients/${p._id}`}
                        className="inline-flex p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 transition-colors"
                        title="Ver ficha clínica"
                      >
                        <HiOutlineEye className="w-4 h-4" />
                      </Link>
                      {canWrite && (
                        <button
                          onClick={() => openEdit(p)}
                          className="p-1.5 rounded-lg hover:bg-emerald-50 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer ml-1"
                          title="Editar"
                        >
                          <HiOutlinePencil className="w-4 h-4" />
                        </button>
                      )}
                      {canDelete && (
                        <button
                          onClick={() => handleDelete(p._id)}
                          className="p-1.5 rounded-lg hover:bg-red-50 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer ml-1"
                          title="Eliminar"
                        >
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

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 px-6 py-4 border-t border-emerald-100">
            <button
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
              className="px-4 py-2 rounded-xl text-sm border border-slate-200 disabled:opacity-50 cursor-pointer bg-white hover:bg-emerald-50"
            >
              Anterior
            </button>
            <span className="text-sm text-slate-500">
              Página {page} de {totalPages}
            </span>
            <button
              disabled={page >= totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="px-4 py-2 rounded-xl text-sm border border-slate-200 disabled:opacity-50 cursor-pointer bg-white hover:bg-emerald-50"
            >
              Siguiente
            </button>
          </div>
        )}
      </div>

      <Modal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Editar Paciente' : 'Nuevo Paciente'}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Cédula" required>
              <input
                name="cedula"
                value={form.cedula}
                onChange={handleChange}
                required
                className="input"
              />
            </Field>
            <Field label="Género">
              <select
                name="gender"
                value={form.gender}
                onChange={handleChange}
                className="input"
              >
                <option value="">Seleccionar</option>
                <option value="masculino">Masculino</option>
                <option value="femenino">Femenino</option>
                <option value="otro">Otro</option>
              </select>
            </Field>
            <Field label="Nombres" required>
              <input
                name="firstName"
                value={form.firstName}
                onChange={handleChange}
                required
                className="input"
              />
            </Field>
            <Field label="Apellidos" required>
              <input
                name="lastName"
                value={form.lastName}
                onChange={handleChange}
                required
                className="input"
              />
            </Field>
            <Field label="Email">
              <input
                name="email"
                type="email"
                value={form.email}
                onChange={handleChange}
                className="input"
              />
            </Field>
            <Field label="Teléfono">
              <input
                name="phone"
                value={form.phone}
                onChange={handleChange}
                className="input"
              />
            </Field>
            <Field label="WhatsApp">
              <input
                name="whatsapp"
                value={form.whatsapp}
                onChange={handleChange}
                className="input"
              />
            </Field>
            <Field label="Fecha de nacimiento">
              <input
                name="birthDate"
                type="date"
                value={form.birthDate}
                onChange={handleChange}
                className="input"
              />
            </Field>
            <Field label="Edad (si no tiene fecha)">
              <input
                name="age"
                type="number"
                min="0"
                max="150"
                value={form.age}
                onChange={handleChange}
                className="input"
                placeholder="Ej: 35"
              />
            </Field>
          </div>
          <Field label="Dirección">
            <input name="address" value={form.address} onChange={handleChange} className="input" />
          </Field>
          <Field label="Notas">
            <textarea
              name="notes"
              value={form.notes}
              onChange={handleChange}
              rows={2}
              className="input resize-none"
            />
          </Field>
          <div className="flex justify-end gap-3 pt-3">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="px-5 py-2.5 border border-slate-200 rounded-xl text-sm text-slate-600 hover:bg-slate-50 cursor-pointer bg-white"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-5 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-700 hover:to-teal-700 text-white rounded-xl text-sm font-medium disabled:opacity-50 cursor-pointer border-none shadow-lg shadow-emerald-200/50"
            >
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear Paciente'}
            </button>
          </div>
        </form>
      </Modal>

      <style>{`
        .input {
          width: 100%;
          padding: 0.625rem 0.875rem;
          border: 1px solid #e2e8f0;
          border-radius: 0.75rem;
          font-size: 0.875rem;
          background: rgba(248, 250, 252, 0.5);
          outline: none;
        }
        .input:focus { border-color: #10b981; background: white; }
      `}</style>
    </div>
  );
}

function Field({ label, required, children }) {
  return (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}
