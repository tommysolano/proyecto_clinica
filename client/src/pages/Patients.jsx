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
  source: '',
  sourceDetail: '',
  antecedentesFamiliares: '',
  antecedentesPatologicos: '',
};

const emptyApt = {
  enabled: false,
  doctor: '',
  date: '',
  startTime: '',
  endTime: '',
  reason: '',
  services: [],
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

  // Para crear cita junto al paciente
  const [doctors, setDoctors] = useState([]);
  const [services, setServices] = useState([]);
  const [aptForm, setAptForm] = useState(emptyApt);

  useEffect(() => {
    if (canWrite) {
      api.get('/users/doctors').then((r) => setDoctors(r.data)).catch(() => {});
      api
        .get('/products', { params: { limit: 500 } })
        .then((r) => {
          const list = (r.data || []).filter(
            (p) => p.active !== false && (p.category === 'servicio' || p.unlimited === true)
          );
          setServices(list);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    setAptForm(emptyApt);
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
    setAptForm(emptyApt);
    setModalOpen(true);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Validaciones de cita inline si está habilitada
    if (aptForm.enabled && !editing) {
      if (!aptForm.doctor || !aptForm.date || !aptForm.startTime || !aptForm.endTime) {
        toast.error('Completa los datos de la cita (doctor, fecha y horario)');
        return;
      }
      if (aptForm.endTime <= aptForm.startTime) {
        toast.error('La hora de fin debe ser posterior a la hora de inicio');
        return;
      }
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        age: form.age === '' ? undefined : Number(form.age),
      };
      let createdId = editing;
      if (editing) {
        await api.put(`/patients/${editing}`, payload);
        toast.success('Paciente actualizado');
      } else {
        const res = await api.post('/patients', payload);
        createdId = res.data._id;
        toast.success('Paciente creado');
      }
      // Crear cita asociada si se solicitó
      if (aptForm.enabled && !editing && createdId) {
        try {
          await api.post('/appointments', {
            patient: createdId,
            doctor: aptForm.doctor,
            date: aptForm.date,
            startTime: aptForm.startTime,
            endTime: aptForm.endTime,
            reason: aptForm.reason,
            status: 'pendiente',
            services: aptForm.services.map((id) => ({ product: id })),
          });
          toast.success('Cita agendada');
        } catch (err) {
          toast.error(
            err.response?.data?.message ||
              'Paciente creado pero no se pudo agendar la cita'
          );
        }
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
                    <td className="px-6 py-3.5 text-sm text-slate-600">{p.cedula || '—'}</td>
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
            <Field label="Cédula">
              <input
                name="cedula"
                value={form.cedula}
                onChange={handleChange}
                className="input"
                placeholder="Opcional"
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
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="¿Cómo nos conoció?">
              <select
                name="source"
                value={form.source}
                onChange={handleChange}
                className="input"
              >
                <option value="">Sin especificar</option>
                <option value="anuncio">Anuncio</option>
                <option value="referido">Referido</option>
                <option value="recepcion">Recepción</option>
                <option value="organico">Orgánico</option>
              </select>
            </Field>
            <Field label="Detalle de procedencia">
              <input
                name="sourceDetail"
                value={form.sourceDetail}
                onChange={handleChange}
                className="input"
                placeholder="Ej: campaña Instagram, referido por María..."
              />
            </Field>
          </div>
          <Field label="Antecedentes familiares">
            <textarea
              name="antecedentesFamiliares"
              value={form.antecedentesFamiliares}
              onChange={handleChange}
              rows={2}
              className="input resize-none"
            />
          </Field>
          <Field label="Antecedentes patológicos">
            <textarea
              name="antecedentesPatologicos"
              value={form.antecedentesPatologicos}
              onChange={handleChange}
              rows={2}
              className="input resize-none"
            />
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
          {!editing && (
            <div className="border-t border-emerald-100 pt-4">
              <label className="flex items-center gap-2 cursor-pointer text-sm font-medium text-slate-700">
                <input
                  type="checkbox"
                  checked={aptForm.enabled}
                  onChange={(e) => setAptForm({ ...aptForm, enabled: e.target.checked })}
                  className="w-4 h-4 accent-emerald-600"
                />
                Agendar cita inmediatamente para este paciente
              </label>
              {aptForm.enabled && (
                <div className="mt-3 space-y-3 bg-emerald-50/40 rounded-xl p-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Doctor" required>
                      <select
                        value={aptForm.doctor}
                        onChange={(e) => setAptForm({ ...aptForm, doctor: e.target.value })}
                        className="input"
                      >
                        <option value="">Seleccionar doctor</option>
                        {doctors.map((d) => (
                          <option key={d._id} value={d._id}>
                            Dr. {d.name} - {d.specialty}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="Fecha" required>
                      <input
                        type="date"
                        value={aptForm.date}
                        onChange={(e) => setAptForm({ ...aptForm, date: e.target.value })}
                        className="input"
                      />
                    </Field>
                    <Field label="Hora inicio" required>
                      <input
                        type="time"
                        value={aptForm.startTime}
                        onChange={(e) => setAptForm({ ...aptForm, startTime: e.target.value })}
                        className="input"
                      />
                    </Field>
                    <Field label="Hora fin" required>
                      <input
                        type="time"
                        value={aptForm.endTime}
                        onChange={(e) => setAptForm({ ...aptForm, endTime: e.target.value })}
                        className="input"
                      />
                    </Field>
                  </div>
                  <Field label="Motivo">
                    <textarea
                      value={aptForm.reason}
                      onChange={(e) => setAptForm({ ...aptForm, reason: e.target.value })}
                      rows={2}
                      className="input resize-none"
                    />
                  </Field>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Servicios
                    </label>
                    <div className="max-h-36 overflow-y-auto bg-white rounded-lg border border-emerald-100 p-2">
                      {services.length === 0 ? (
                        <p className="text-xs text-slate-400 text-center py-2">Sin servicios</p>
                      ) : (
                        services.map((s) => {
                          const checked = aptForm.services.includes(s._id);
                          return (
                            <label
                              key={s._id}
                              className={`flex items-center gap-2 px-2 py-1 rounded text-sm cursor-pointer ${
                                checked ? 'bg-emerald-100' : 'hover:bg-emerald-50'
                              }`}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() =>
                                  setAptForm((prev) => ({
                                    ...prev,
                                    services: prev.services.includes(s._id)
                                      ? prev.services.filter((x) => x !== s._id)
                                      : [...prev.services, s._id],
                                  }))
                                }
                                className="w-4 h-4 accent-emerald-600"
                              />
                              <span className="flex-1">{s.name}</span>
                              <span className="text-xs text-slate-500">
                                ${Number(s.salePrice).toFixed(2)}
                              </span>
                            </label>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
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
