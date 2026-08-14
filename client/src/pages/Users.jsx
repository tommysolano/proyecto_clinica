import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import PageHeader, { EmptyState } from '../components/PageHeader';
import SriStatus from '../components/SriStatus';
import useSriLookup, { fillField } from '../hooks/useSriLookup';
import EmailStatus from '../components/EmailStatus';
import useEmailValidation from '../hooks/useEmailValidation';
import { useAuth } from '../context/AuthContext';
import { roleSatisfies } from '../utils/roles';
import {
  HiOutlineUserPlus,
  HiOutlinePencilSquare,
  HiOutlineTrash,
  HiOutlineUsers,
} from 'react-icons/hi2';

const ROLES = [
  { value: 'admin', label: 'Administrador' },
  { value: 'cajero', label: 'Cajero' },
  { value: 'contabilidad', label: 'Contabilidad' },
  { value: 'doctor', label: 'Doctor' },
  { value: 'ginecologia', label: 'Ginecología' },
  { value: 'podologia', label: 'Podología' },
  { value: 'odontologia', label: 'Odontología' },
  { value: 'cosmetologia', label: 'Cosmetología' },
  { value: 'optica', label: 'Óptica' },
  { value: 'call_center', label: 'Call Center' },
  { value: 'marketing', label: 'Marketing' },
  { value: 'enfermero', label: 'Enfermero/a' },
];

const EMPTY = {
  name: '',
  email: '',
  password: '',
  role: 'cajero',
  cedula: '',
  phone: '',
  specialty: '',
};

export default function Users() {
  const { activeClinic } = useAuth();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  // Autocompletado por cédula/RUC desde el SRI (nombre completo).
  const cedulaLookup = useSriLookup(form.cedula, {
    enabled: showModal && !editing,
    onData: (d, prev) => {
      setForm((f) => ({ ...f, name: fillField(f.name, d.found ? d.fullName || '' : '', prev?.fullName) }));
    },
  });
  const emailCheck = useEmailValidation(form.email, { enabled: showModal });

  const load = async () => {
    setLoading(true);
    try {
      const res = await api.get('/users');
      setUsers(res.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar usuarios');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const openNew = () => {
    setEditing(null);
    setForm(EMPTY);
    setShowModal(true);
  };

  const openEdit = (u) => {
    setEditing(u);
    const roleHere = u.clinics?.find(
      (c) => String(c.clinic?._id || c.clinic) === String(activeClinic?._id)
    )?.role;
    setForm({
      name: u.name || '',
      email: u.email || '',
      password: '',
      role: roleHere || 'cajero',
      cedula: u.cedula || '',
      phone: u.phone || '',
      specialty: u.specialty || '',
    });
    setShowModal(true);
  };

  const handleChange = (field, value) => setForm((p) => ({ ...p, [field]: value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editing) {
        const payload = {
          name: form.name,
          email: form.email,
          cedula: form.cedula,
          phone: form.phone,
          specialty: form.specialty,
          clinics: [{ clinic: activeClinic._id, role: form.role }],
        };
        if (form.password) payload.password = form.password;
        await api.put(`/users/${editing._id}`, payload);
        toast.success('Usuario actualizado');
      } else {
        if (!form.password || form.password.length < 6) {
          toast.error('La contraseña debe tener al menos 6 caracteres');
          setSaving(false);
          return;
        }
        await api.post('/users', form);
        toast.success('Usuario creado');
      }
      setShowModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (u) => {
    if (!confirm(`¿Desactivar al usuario ${u.name}?`)) return;
    try {
      await api.delete(`/users/${u._id}`);
      toast.success('Usuario desactivado');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const roleHere = (u) => {
    const r = u.clinics?.find(
      (c) => String(c.clinic?._id || c.clinic) === String(activeClinic?._id)
    )?.role;
    return r || '—';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-emerald-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      <PageHeader icon={HiOutlineUsers} title="Usuarios de la sucursal" subtitle="Gestiona el personal y sus roles">
        <button onClick={openNew} className="btn-primary">
          <HiOutlineUserPlus className="w-4 h-4" /> Nuevo usuario
        </button>
      </PageHeader>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-slate-200 overflow-hidden">
        <table className="tbl">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Nombre</th>
              <th className="text-left px-4 py-3 font-semibold">Email</th>
              <th className="text-left px-4 py-3 font-semibold">Rol</th>
              <th className="text-left px-4 py-3 font-semibold">Cédula</th>
              <th className="text-left px-4 py-3 font-semibold">Teléfono</th>
              <th className="text-left px-4 py-3 font-semibold">Estado</th>
              <th className="text-right px-4 py-3 font-semibold">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.length === 0 && (
              <tr>
                <td colSpan={7}>
                  <EmptyState icon={HiOutlineUsers} title="No hay usuarios" hint="Crea el primer usuario de la sucursal." />
                </td>
              </tr>
            )}
            {users.map((u) => (
              <tr key={u._id} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-4 py-3 font-medium text-slate-800">
                  {u.name}
                  {u.isSuperAdmin && (
                    <span className="ml-2 text-xs px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded">
                      super
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-slate-600">{u.email}</td>
                <td className="px-4 py-3 capitalize text-slate-700">{roleHere(u)}</td>
                <td className="px-4 py-3 text-slate-600">{u.cedula || '—'}</td>
                <td className="px-4 py-3 text-slate-600">{u.phone || '—'}</td>
                <td className="px-4 py-3">
                  {u.active ? (
                    <span className="text-xs px-2 py-1 bg-emerald-100 text-emerald-700 rounded">
                      Activo
                    </span>
                  ) : (
                    <span className="text-xs px-2 py-1 bg-slate-100 text-slate-500 rounded">
                      Inactivo
                    </span>
                  )}
                </td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-2">
                    <button
                      onClick={() => openEdit(u)}
                      className="p-1.5 text-slate-500 hover:text-emerald-600 hover:bg-emerald-50 rounded cursor-pointer bg-transparent border-none"
                      title="Editar"
                    >
                      <HiOutlinePencilSquare className="w-4 h-4" />
                    </button>
                    <button
                      onClick={() => handleDelete(u)}
                      className="p-1.5 text-slate-500 hover:text-red-600 hover:bg-red-50 rounded cursor-pointer bg-transparent border-none"
                      title="Desactivar"
                      disabled={u.isSuperAdmin}
                    >
                      <HiOutlineTrash className="w-4 h-4" />
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        title={editing ? 'Editar usuario' : 'Nuevo usuario'}
        size="lg"
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Field label="Nombre" required>
              <input
                type="text"
                value={form.name}
                onChange={(e) => handleChange('name', e.target.value)}
                required
                className="input"
              />
            </Field>
            <Field label="Email" required>
              <input
                type="email"
                value={form.email}
                onChange={(e) => handleChange('email', e.target.value)}
                required
                className="input"
              />
              <EmailStatus status={emailCheck} onApplySuggestion={(s) => handleChange('email', s)} />
            </Field>
            <Field label={editing ? 'Nueva contraseña (opcional)' : 'Contraseña'} required={!editing}>
              <input
                type="password"
                value={form.password}
                onChange={(e) => handleChange('password', e.target.value)}
                className="input"
                autoComplete="new-password"
                minLength={editing ? undefined : 6}
              />
            </Field>
            <Field label="Rol" required>
              <select
                value={form.role}
                onChange={(e) => handleChange('role', e.target.value)}
                className="input"
                required
              >
                {ROLES.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Cédula / Pasaporte">
              <input
                type="text"
                value={form.cedula}
                onChange={(e) => handleChange('cedula', e.target.value)}
                className="input"
                maxLength={20}
              />
              <SriStatus status={cedulaLookup} />
            </Field>
            <Field label="Teléfono">
              <input
                type="text"
                value={form.phone}
                onChange={(e) => handleChange('phone', e.target.value)}
                className="input"
              />
            </Field>
            {roleSatisfies(form.role, ['doctor']) && (
              <Field label="Especialidad">
                <input
                  type="text"
                  value={form.specialty}
                  onChange={(e) => handleChange('specialty', e.target.value)}
                  className="input"
                />
              </Field>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-4 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setShowModal(false)}
              className="px-4 py-2 text-slate-600 hover:bg-slate-100 rounded-xl cursor-pointer bg-transparent border-none text-sm"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg font-medium disabled:opacity-50 cursor-pointer border-none text-sm"
            >
              {saving ? 'Guardando...' : editing ? 'Actualizar' : 'Crear'}
            </button>
          </div>
        </form>
      </Modal>

      <style>{`
        .input {
          width: 100%;
          padding: 0.625rem 0.875rem;
          border: 1px solid #e2e8f0;
          border-radius: 0.5rem;
          font-size: 0.875rem;
          background: #f8fafc;
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
      <label className="block text-sm font-semibold text-slate-700 mb-1.5">
        {label} {required && <span className="text-red-500">*</span>}
      </label>
      {children}
    </div>
  );
}
