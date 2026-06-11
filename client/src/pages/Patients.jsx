import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../api/axios';
import { downloadFile } from '../utils/download';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { useSocketEvent } from '../context/SocketContext';
import {
  HiOutlinePlus,
  HiOutlinePencil,
  HiOutlineTrash,
  HiOutlineMagnifyingGlass,
  HiOutlineEye,
  HiOutlineUsers,
  HiOutlineArrowDownTray,
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
  source: '',
  referredByName: '',
  referredById: '',
  referredByType: '',
};

const emptyApt = {
  enabled: false,
  clinic: '',
  date: '',
  startTime: '',
  room: '',
  reason: '',
  services: [],
};

export default function Patients() {
  const { hasRole, clinics, activeClinic } = useAuth();
  const showClinicSelector = (clinics?.length || 0) > 1;
  const canWrite = hasRole('admin', 'cajero', 'call_center');
  const canDelete = hasRole('admin');

  const [patients, setPatients] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [cedulaLookup, setCedulaLookup] = useState({ loading: false, msg: '', error: false });

  // Para crear cita junto al paciente
  const [rooms, setRooms] = useState([]);
  const [services, setServices] = useState([]);
  const [aptForm, setAptForm] = useState(emptyApt);
  const [serviceSearch, setServiceSearch] = useState('');
  const [dayApts, setDayApts] = useState([]);
  const [loadingApts, setLoadingApts] = useState(false);

  useEffect(() => {
    if (canWrite) {
      api.get('/rooms').then((r) => setRooms(r.data || [])).catch(() => {});
      api
        .get('/products', { params: { limit: 500 } })
        .then((r) => {
          const list = (r.data || []).filter(
            (p) => p.active !== false && (p.category === 'servicio' || p.category === 'programa' || p.unlimited === true)
          );
          setServices(list);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!aptForm.enabled || !aptForm.date) { setDayApts([]); return; }
    setLoadingApts(true);
    api.get('/appointments', { params: { startDate: aptForm.date, endDate: aptForm.date } })
      .then((r) => setDayApts(r.data || []))
      .catch(() => setDayApts([]))
      .finally(() => setLoadingApts(false));
  }, [aptForm.date, aptForm.enabled]);

  const fetchPatients = async () => {
    try {
      const params = { search, page, limit: 15 };
      if (onlyNew) params.isNew = 'true';
      const res = await api.get('/patients', { params });
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
  }, [search, page, onlyNew]);

  useSocketEvent('patient:created', () => fetchPatients(), [search, page, onlyNew]);
  useSocketEvent('patient:updated', () => fetchPatients(), [search, page, onlyNew]);

  // Autocompletado por cédula: al ingresar 10 dígitos consultamos el SRI para
  // llenar nombres/apellidos. La fecha de nacimiento y el género no están en
  // fuentes públicas gratuitas en Ecuador, así que esos se ingresan a mano.
  useEffect(() => {
    const ced = (form.cedula || '').trim();
    if (!modalOpen || editing || !/^\d{10}$/.test(ced)) {
      setCedulaLookup({ loading: false, msg: '', error: false });
      return;
    }
    let cancelled = false;
    setCedulaLookup({ loading: true, msg: 'Buscando datos…', error: false });
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get(`/patients/lookup/${ced}`);
        if (cancelled) return;
        if (data.alreadyExists) {
          setCedulaLookup({ loading: false, error: true, msg: 'Ya existe un paciente con esta cédula.' });
          return;
        }
        if (data.found) {
          setForm((f) => ({
            ...f,
            // No sobrescribimos lo que el usuario ya escribió.
            firstName: f.firstName?.trim() ? f.firstName : (data.firstName || '').toUpperCase(),
            lastName: f.lastName?.trim() ? f.lastName : (data.lastName || '').toUpperCase(),
          }));
          setCedulaLookup({ loading: false, error: false, msg: `Datos encontrados: ${data.fullName}` });
        } else {
          setCedulaLookup({ loading: false, error: false, msg: 'Sin datos públicos para esta cédula. Ingrésalos manualmente.' });
        }
      } catch (err) {
        if (cancelled) return;
        const m = err.response?.data?.message || 'No se pudo consultar la cédula';
        setCedulaLookup({ loading: false, error: true, msg: m });
      }
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.cedula, modalOpen, editing]);

  const openNew = () => {
    setEditing(null);
    setForm(emptyForm);
    setAptForm(emptyApt);
    setServiceSearch('');
    setDayApts([]);
    setCedulaLookup({ loading: false, msg: '', error: false });
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
    if (!form.gender) {
      toast.error('El género es obligatorio');
      return;
    }
    // Validaciones de cita inline si está habilitada
    if (aptForm.enabled && !editing) {
      if (!aptForm.date || !aptForm.startTime) {
        toast.error('Completa los datos de la cita (fecha y hora)');
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
          const aptClinic = aptForm.clinic || activeClinic?._id;
          // Sala y servicios pertenecen a la sucursal activa; si se agenda en otra
          // sucursal, se omiten para evitar referencias cruzadas inválidas.
          const sameClinic = !aptForm.clinic || String(aptForm.clinic) === String(activeClinic?._id);
          await api.post('/appointments', {
            patient: createdId,
            clinic: aptClinic,
            date: aptForm.date,
            startTime: aptForm.startTime,
            room: sameClinic ? aptForm.room || undefined : undefined,
            reason: aptForm.reason,
            status: 'pendiente',
            services: sameClinic ? aptForm.services.map((id) => ({ product: id })) : [],
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

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm({ ...form, [name]: (name === 'firstName' || name === 'lastName') ? value.toUpperCase() : value });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-2xl bg-emerald-100 text-emerald-700 flex items-center justify-center shadow-sm">
            <HiOutlineUsers className="w-6 h-6" />
          </div>
          <div>
            <h1 className="page-title">Pacientes</h1>
            <p className="page-subtitle">Gestión de pacientes registrados</p>
          </div>
        </div>
        {canWrite && (
          <div className="flex gap-2">
            <button
              onClick={async () => {
                try {
                  await downloadFile('/reports/patients.xlsx', { filename: `pacientes_${Date.now()}.xlsx` });
                } catch (err) {
                  toast.error(err.message || 'Error al exportar');
                }
              }}
              className="btn-secondary"
            >
              <HiOutlineArrowDownTray className="w-4 h-4" /> Excel
            </button>
            <button onClick={openNew} className="btn-primary">
              <HiOutlinePlus className="w-5 h-5" /> Nuevo Paciente
            </button>
          </div>
        )}
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4">
        <div className="flex gap-3 items-center flex-wrap">
          <div className="relative flex-1 min-w-[240px]">
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
          <button
            onClick={() => {
              setOnlyNew((v) => !v);
              setPage(1);
            }}
            className={`px-4 py-3 rounded-xl text-sm font-medium border whitespace-nowrap cursor-pointer ${
              onlyNew
                ? 'bg-emerald-600 text-white border-emerald-600'
                : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
            }`}
          >
            {onlyNew ? '✓ Solo pacientes nuevos' : 'Solo pacientes nuevos'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl">
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
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`sk-${i}`} className="border-b border-emerald-50">
                    {Array.from({ length: 5 }).map((__, j) => (
                      <td key={j} className="px-6 py-3.5"><div className="skeleton h-4 w-full max-w-[160px]" /></td>
                    ))}
                  </tr>
                ))
              ) : patients.length === 0 ? (
                <tr>
                  <td colSpan="5">
                    <div className="empty-state">
                      <HiOutlineUsers className="w-10 h-10 text-slate-300" />
                      <p className="font-medium text-slate-500">No se encontraron pacientes</p>
                      <p className="text-xs text-slate-400">Ajusta la búsqueda o registra un nuevo paciente.</p>
                    </div>
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
                placeholder="Opcional — autocompleta el nombre"
                inputMode="numeric"
              />
              {cedulaLookup.msg && (
                <p className={`text-[11px] mt-1 ${cedulaLookup.error ? 'text-red-500' : cedulaLookup.loading ? 'text-slate-400' : 'text-emerald-600'}`}>
                  {cedulaLookup.msg}
                </p>
              )}
            </Field>
            <Field label="Género" required>
              <select
                name="gender"
                value={form.gender}
                onChange={handleChange}
                required
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
            {form.source === 'referido' && (
              <ReferralPicker
                value={form.referredByName}
                onSelect={(sel) =>
                  setForm((f) => ({
                    ...f,
                    referredByName: sel.name,
                    referredById: sel.id || '',
                    referredByType: sel.type || '',
                  }))
                }
                onClear={() =>
                  setForm((f) => ({ ...f, referredByName: '', referredById: '', referredByType: '' }))
                }
              />
            )}
          </div>
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
                  {showClinicSelector && (
                    <Field label="Sucursal destino *">
                      <select
                        value={aptForm.clinic || activeClinic?._id || ''}
                        onChange={(e) => setAptForm({ ...aptForm, clinic: e.target.value, room: '' })}
                        className="input"
                      >
                        {clinics.map((c) => (
                          <option key={c._id} value={c._id}>{c.nombreComercial || c.name}</option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <Field label="Fecha" required>
                      <input
                        type="date"
                        value={aptForm.date}
                        onChange={(e) => setAptForm({ ...aptForm, date: e.target.value })}
                        className="input"
                      />
                    </Field>
                    <Field label="Hora" required>
                      <input
                        type="time"
                        value={aptForm.startTime}
                        onChange={(e) => setAptForm({ ...aptForm, startTime: e.target.value })}
                        className="input"
                      />
                    </Field>
                    {(!aptForm.clinic || String(aptForm.clinic) === String(activeClinic?._id)) && (
                      <Field label="Consultorio">
                        <select
                          value={aptForm.room}
                          onChange={(e) => setAptForm({ ...aptForm, room: e.target.value })}
                          className="input"
                        >
                          <option value="">— Sin asignar —</option>
                          {rooms.map((r) => (
                            <option key={r._id} value={r._id}>{r.name}</option>
                          ))}
                        </select>
                      </Field>
                    )}
                  </div>
                  <Field label="Motivo">
                    <textarea
                      value={aptForm.reason}
                      onChange={(e) => setAptForm({ ...aptForm, reason: e.target.value })}
                      rows={2}
                      className="input resize-none"
                    />
                  </Field>
                  {aptForm.date && (
                    <div className="bg-white rounded-lg border border-emerald-100 p-2">
                      <p className="text-xs font-medium text-slate-600 mb-1">
                        Citas agendadas para este día
                      </p>
                      {loadingApts ? (
                        <p className="text-xs text-slate-400 py-1">Cargando...</p>
                      ) : dayApts.length === 0 ? (
                        <p className="text-xs text-emerald-600 py-1">Sin citas — horario disponible</p>
                      ) : (
                        <div className="max-h-24 overflow-y-auto space-y-0.5">
                          {dayApts
                            .slice()
                            .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''))
                            .map((a) => (
                              <div key={a._id} className="flex items-center gap-2 text-xs text-slate-600 py-0.5">
                                <span className="font-medium text-slate-800 w-12 shrink-0">{a.startTime || '—'}</span>
                                <span className="truncate">{a.patient?.firstName} {a.patient?.lastName}</span>
                                {a.services?.length > 0 && (
                                  <span className="text-slate-400 truncate hidden sm:block">· {a.services.map(s => s.name).join(', ')}</span>
                                )}
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  )}
                  {(!aptForm.clinic || String(aptForm.clinic) === String(activeClinic?._id)) ? (
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">
                      Servicios
                    </label>
                    <div className="relative mb-1.5">
                      <HiOutlineMagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400 pointer-events-none" />
                      <input
                        type="text"
                        placeholder="Buscar servicio..."
                        value={serviceSearch}
                        onChange={(e) => setServiceSearch(e.target.value)}
                        className="input pl-7 py-1.5 text-xs"
                      />
                    </div>
                    <div className="max-h-36 overflow-y-auto bg-white rounded-lg border border-emerald-100 p-2">
                      {services.length === 0 ? (
                        <p className="text-xs text-slate-400 text-center py-2">Sin servicios</p>
                      ) : (() => {
                          const filtered = services.filter((s) =>
                            s.name.toLowerCase().includes(serviceSearch.toLowerCase())
                          );
                          return filtered.length === 0 ? (
                            <p className="text-xs text-slate-400 text-center py-2">Sin resultados</p>
                          ) : (
                            filtered.map((s) => {
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
                          );
                        })()
                      }
                    </div>
                  </div>
                  ) : (
                    <p className="text-xs text-slate-500 bg-white rounded-lg border border-emerald-100 p-2">
                      La sala y los servicios se asignan en la sucursal de destino al gestionar la cita.
                    </p>
                  )}
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

// Buscador de "¿Quién lo refirió?" — pacientes y personal registrados.
function ReferralPicker({ value, onSelect, onClear }) {
  const [query, setQuery] = useState(value || '');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(!!value);

  useEffect(() => {
    if (selected || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const t = setTimeout(async () => {
      try {
        const res = await api.get('/patients/referral-options', { params: { q: query } });
        setResults(res.data || []);
        setOpen(true);
      } catch {
        setResults([]);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query, selected]);

  return (
    <Field label="¿Quién lo refirió?">
      <div className="relative">
        <input
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(false);
          }}
          className="input"
          placeholder="Buscar paciente o personal..."
        />
        {selected && query && (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setSelected(false);
              onClear();
            }}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-red-500 bg-transparent border-none cursor-pointer"
          >
            ✕
          </button>
        )}
        {open && !selected && results.length > 0 && (
          <div className="absolute z-10 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
            {results.map((r) => (
              <button
                key={`${r.type}-${r.id}`}
                type="button"
                onClick={() => {
                  onSelect(r);
                  setQuery(r.name);
                  setSelected(true);
                  setOpen(false);
                }}
                className="w-full text-left px-3 py-2 text-sm hover:bg-emerald-50 bg-transparent border-none cursor-pointer flex justify-between gap-2"
              >
                <span>{r.name}</span>
                <span className="text-xs text-slate-400">{r.type === 'user' ? 'Personal' : r.detail}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </Field>
  );
}
