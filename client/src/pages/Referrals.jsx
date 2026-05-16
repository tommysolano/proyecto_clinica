import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { HiOutlinePlus, HiOutlineArrowsRightLeft, HiOutlineTrash } from 'react-icons/hi2';

const STATUSES = [
  { value: 'pendiente', label: 'Pendiente', color: 'bg-amber-100 text-amber-800' },
  { value: 'agendada', label: 'Agendada', color: 'bg-sky-100 text-sky-800' },
  { value: 'atendida', label: 'Atendida', color: 'bg-emerald-100 text-emerald-800' },
  { value: 'cancelada', label: 'Cancelada', color: 'bg-rose-100 text-rose-800' },
];

const EMPTY = {
  patient: '',
  toDoctor: '',
  specialty: '',
  reason: '',
  notes: '',
  date: new Date().toISOString().slice(0, 10),
};

export default function Referrals() {
  const { hasRole, user } = useAuth();
  const canCreate = hasRole('admin', 'doctor');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [toDoctorFilter, setToDoctorFilter] = useState('');
  const [specialtyFilter, setSpecialtyFilter] = useState('');
  const [qFilter, setQFilter] = useState('');
  const [showModal, setShowModal] = useState(false);
  const [form, setForm] = useState(EMPTY);
  const [patients, setPatients] = useState([]);
  const [doctors, setDoctors] = useState([]);
  const [stats, setStats] = useState(null);

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (statusFilter) params.status = statusFilter;
      if (toDoctorFilter) params.toDoctor = toDoctorFilter;
      if (specialtyFilter) params.specialty = specialtyFilter;
      if (qFilter.trim()) params.q = qFilter.trim();
      const [r, s] = await Promise.all([
        api.get('/referrals', { params }),
        hasRole('admin', 'doctor', 'marketing')
          ? api.get('/referrals/stats').catch(() => ({ data: null }))
          : Promise.resolve({ data: null }),
      ]);
      setList(r.data || []);
      setStats(s.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    Promise.all([
      api.get('/patients').then((r) => setPatients(r.data.patients || r.data || [])),
      api.get('/users').then((r) => setDoctors(r.data || [])),
    ]).catch(() => {});
  }, []);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter, toDoctorFilter, specialtyFilter, qFilter]);

  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post('/referrals', form);
      toast.success('Derivación creada');
      setShowModal(false);
      setForm(EMPTY);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const updateStatus = async (r, status) => {
    try {
      await api.put(`/referrals/${r._id}`, { status });
      toast.success('Estado actualizado');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const remove = async (r) => {
    if (!confirm('¿Eliminar derivación?')) return;
    try {
      await api.delete(`/referrals/${r._id}`);
      toast.success('Eliminada');
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <HiOutlineArrowsRightLeft className="text-emerald-600" /> Derivaciones
          </h1>
          <p className="text-sm text-slate-500">
            Pacientes derivados entre doctores y especialidades.
          </p>
        </div>
        {canCreate && (
          <button
            onClick={() => setShowModal(true)}
            className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2 hover:bg-emerald-700"
          >
            <HiOutlinePlus className="w-4 h-4" /> Nueva derivación
          </button>
        )}
      </div>

      {stats?.byDoctor?.length > 0 && (
        <div className="grid sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
          {stats.byDoctor.map((d) => (
            <div key={d._id} className="bg-white rounded-xl border border-slate-200 p-3">
              <div className="text-xs text-slate-500">{d.specialty || 'Doctor'}</div>
              <div className="font-semibold text-slate-800">{d.name}</div>
              <div className="text-xl font-bold text-emerald-600">{d.count}</div>
              <div className="text-xs text-slate-400">derivaciones</div>
            </div>
          ))}
        </div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 p-3 grid sm:grid-cols-2 md:grid-cols-4 gap-2">
        <input
          type="text"
          value={qFilter}
          onChange={(e) => setQFilter(e.target.value)}
          placeholder="Buscar paciente..."
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
        />
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">Todos los estados</option>
          {STATUSES.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
        <select
          value={toDoctorFilter}
          onChange={(e) => setToDoctorFilter(e.target.value)}
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">Todos los doctores destino</option>
          {doctors.map((d) => (
            <option key={d._id} value={d._id}>{d.name}</option>
          ))}
        </select>
        <input
          type="text"
          value={specialtyFilter}
          onChange={(e) => setSpecialtyFilter(e.target.value)}
          placeholder="Especialidad..."
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
        />
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Fecha</th>
              <th className="text-left px-3 py-2">Paciente</th>
              <th className="text-left px-3 py-2">De</th>
              <th className="text-left px-3 py-2">Hacia</th>
              <th className="text-left px-3 py-2">Especialidad</th>
              <th className="text-left px-3 py-2">Motivo</th>
              <th className="text-left px-3 py-2">Estado</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={8} className="text-center py-4 text-slate-400">
                  Cargando...
                </td>
              </tr>
            )}
            {list.map((r) => {
              const st = STATUSES.find((s) => s.value === r.status) || STATUSES[0];
              return (
                <tr key={r._id} className="border-t border-slate-100">
                  <td className="px-3 py-2">{(r.date || '').slice(0, 10)}</td>
                  <td className="px-3 py-2">
                    {r.patient?.firstName} {r.patient?.lastName}
                  </td>
                  <td className="px-3 py-2">{r.fromDoctor?.name || '—'}</td>
                  <td className="px-3 py-2">{r.toDoctor?.name || '—'}</td>
                  <td className="px-3 py-2">{r.specialty || '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{r.reason}</td>
                  <td className="px-3 py-2">
                    {hasRole('admin', 'cajero') ? (
                      <select
                        value={r.status}
                        onChange={(e) => updateStatus(r, e.target.value)}
                        className={`text-xs rounded px-2 py-1 ${st.color}`}
                      >
                        {STATUSES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className={`text-xs rounded px-2 py-1 ${st.color}`}>
                        {st.label}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {hasRole('admin') && (
                      <button onClick={() => remove(r)} className="text-rose-600 hover:bg-rose-50 p-1 rounded">
                        <HiOutlineTrash className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {!loading && list.length === 0 && (
              <tr>
                <td colSpan={8} className="text-center py-6 text-slate-400">
                  Sin derivaciones
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title="Nueva derivación">
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Paciente</span>
            <select
              required
              value={form.patient}
              onChange={(e) => setForm({ ...form, patient: e.target.value })}
              className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            >
              <option value="">Seleccionar...</option>
              {patients.map((p) => (
                <option key={p._id} value={p._id}>
                  {p.firstName} {p.lastName}
                </option>
              ))}
            </select>
          </label>
          <div className="grid sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Doctor destino</span>
              <select
                value={form.toDoctor}
                onChange={(e) => setForm({ ...form, toDoctor: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              >
                <option value="">—</option>
                {doctors.map((d) => (
                  <option key={d._id} value={d._id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-slate-600">Especialidad</span>
              <input
                value={form.specialty}
                onChange={(e) => setForm({ ...form, specialty: e.target.value })}
                className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Motivo</span>
            <input
              required
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
              className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Notas</span>
            <textarea
              rows={2}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg border border-slate-200">
              Cancelar
            </button>
            <button type="submit" className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">
              Crear
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
