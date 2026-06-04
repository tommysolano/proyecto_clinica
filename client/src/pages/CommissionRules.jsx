import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { HiOutlinePlus, HiOutlineTrash, HiOutlinePencil, HiOutlineTrophy } from 'react-icons/hi2';

const ROLES = [
  { value: 'doctor', label: 'Doctor' },
  { value: 'optica', label: 'Óptica' },
  { value: 'enfermero', label: 'Enfermero/a' },
  { value: 'cajero', label: 'Cajero' },
  { value: 'call_center', label: 'Call Center' },
  { value: 'marketing', label: 'Marketing' },
];

// Eventos que devengan la comisión.
const TRIGGERS = {
  appointment_performed: 'Cuando atiende una cita (pasa a completada)',
  appointment_created: 'Cuando una cita que agendó pasa a completada',
  sale: 'Cuando registra una venta',
  recommendation: 'Cuando recomienda un producto/servicio vendido',
};

// Triggers sugeridos según el rol seleccionado (el modal se adapta al rol).
const TRIGGERS_BY_ROLE = {
  doctor: ['appointment_performed', 'recommendation'],
  optica: ['appointment_performed', 'recommendation'],
  enfermero: ['appointment_performed', 'recommendation'],
  cajero: ['sale', 'recommendation'],
  call_center: ['appointment_created', 'recommendation'],
  marketing: ['appointment_created', 'sale', 'recommendation'],
};
const ALL_TRIGGERS = Object.keys(TRIGGERS);

const triggersForRole = (role) => TRIGGERS_BY_ROLE[role] || ALL_TRIGGERS;
const DAYS = [
  { v: 1, l: 'Lun' }, { v: 2, l: 'Mar' }, { v: 3, l: 'Mié' }, { v: 4, l: 'Jue' },
  { v: 5, l: 'Vie' }, { v: 6, l: 'Sáb' }, { v: 0, l: 'Dom' },
];

const EMPTY = {
  name: '', active: true, targetType: 'role', user: '', role: 'doctor',
  trigger: 'appointment_performed',
  service: '', patientScope: 'all', scheduleEnabled: false, daysOfWeek: [],
  startTime: '', endTime: '', amount: '', account: '',
};

export default function CommissionRules() {
  const [tab, setTab] = useState('rules');
  const [rules, setRules] = useState([]);
  const [users, setUsers] = useState([]);
  const [services, setServices] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);

  // Reporte
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const [start, setStart] = useState(monthAgo);
  const [end, setEnd] = useState(today);
  const [userFilter, setUserFilter] = useState('');
  const [report, setReport] = useState(null);

  const load = async () => {
    try {
      const [r, u, p] = await Promise.all([
        api.get('/commissions/rules'),
        api.get('/users').catch(() => ({ data: [] })),
        api.get('/products', { params: { limit: 500 } }).catch(() => ({ data: [] })),
      ]);
      setRules(r.data || []);
      setUsers(u.data || []);
      const list = Array.isArray(p.data) ? p.data : p.data?.products || [];
      // Aceptamos servicios, programas, items (medicamento, insumo) — todos pueden tener comisión.
      setServices(list.filter((x) => x.active !== false));
      api.get('/chart-of-accounts', { params: { active: true } }).then((a) => setAccounts((a.data || []).filter((x) => x.allowsMovement))).catch(() => {});
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar');
    }
  };
  useEffect(() => { load(); }, []);

  const loadReport = async () => {
    try {
      const res = await api.get('/commissions/report', { params: { start, end, user: userFilter || undefined } });
      setReport(res.data);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al calcular');
    }
  };
  useEffect(() => { if (tab === 'report') loadReport(); /* eslint-disable-next-line */ }, [tab]);

  const openNew = () => { setEditing(null); setForm(EMPTY); setModal(true); };
  const openEdit = (r) => {
    setEditing(r._id);
    setForm({
      name: r.name, active: r.active, targetType: r.targetType,
      user: r.user?._id || r.user || '', role: r.role || 'doctor',
      trigger: r.trigger || 'appointment_performed',
      service: r.service?._id || r.service || '', patientScope: r.patientScope,
      scheduleEnabled: r.scheduleEnabled, daysOfWeek: r.daysOfWeek || [],
      startTime: r.startTime || '', endTime: r.endTime || '', amount: String(r.amount),
      account: r.account?._id || r.account || '',
    });
    setModal(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name || !form.amount) { toast.error('Nombre y monto son obligatorios'); return; }
    setSaving(true);
    try {
      const body = {
        ...form,
        amount: parseFloat(form.amount) || 0,
        user: form.targetType === 'user' ? form.user : null,
        role: form.targetType === 'role' ? form.role : '',
        service: form.service || null,
        account: form.account || null,
      };
      if (editing) await api.put(`/commissions/rules/${editing}`, body);
      else await api.post('/commissions/rules', body);
      toast.success('Regla guardada');
      setModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al guardar');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (id) => {
    if (!confirm('¿Eliminar esta regla?')) return;
    try { await api.delete(`/commissions/rules/${id}`); toast.success('Eliminada'); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
          <HiOutlineTrophy className="text-emerald-600" /> Comisiones
        </h1>
        {tab === 'rules' && (
          <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2 hover:bg-emerald-700 border-none cursor-pointer">
            <HiOutlinePlus className="w-4 h-4" /> Nueva regla
          </button>
        )}
      </div>

      <div className="flex gap-1 bg-emerald-50 rounded-xl p-1 w-fit">
        {['rules', 'report'].map((t) => (
          <button key={t} onClick={() => setTab(t)}
            className={`px-5 py-2 rounded-lg text-sm font-medium cursor-pointer border-none ${tab === t ? 'bg-white text-emerald-700 shadow-sm' : 'text-slate-500 bg-transparent'}`}>
            {t === 'rules' ? 'Reglas' : 'Comisiones por usuario'}
          </button>
        ))}
      </div>

      {tab === 'rules' && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="text-left px-3 py-2">Nombre</th>
                <th className="text-left px-3 py-2">Aplica a</th>
                <th className="text-left px-3 py-2">Servicio</th>
                <th className="text-left px-3 py-2">Pacientes</th>
                <th className="text-right px-3 py-2">Monto</th>
                <th className="text-center px-3 py-2">Activa</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {rules.length === 0 && <tr><td colSpan={7} className="text-center py-6 text-slate-400">Sin reglas de comisión</td></tr>}
              {rules.map((r) => (
                <tr key={r._id} className="border-t border-slate-100">
                  <td className="px-3 py-2 font-medium">{r.name}</td>
                  <td className="px-3 py-2">
                    <div>{r.targetType === 'user' ? (r.user?.name || 'Usuario') : `Rol: ${r.role}`}</div>
                    <div className="text-[11px] text-slate-400">{TRIGGERS[r.trigger] || TRIGGERS.appointment_performed}</div>
                  </td>
                  <td className="px-3 py-2">{r.service?.name || 'Cualquier servicio'}</td>
                  <td className="px-3 py-2">{r.patientScope === 'new' ? 'Solo nuevos' : 'Todos'}</td>
                  <td className="px-3 py-2 text-right">${Number(r.amount).toFixed(2)}</td>
                  <td className="px-3 py-2 text-center">{r.active ? '✓' : '—'}</td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    <button onClick={() => openEdit(r)} className="p-1 text-slate-400 hover:text-emerald-600 bg-transparent border-none cursor-pointer"><HiOutlinePencil className="w-4 h-4" /></button>
                    <button onClick={() => remove(r._id)} className="p-1 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer"><HiOutlineTrash className="w-4 h-4" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'report' && (
        <div className="space-y-3">
          <div className="bg-white rounded-xl border border-slate-200 p-3 flex flex-wrap gap-3 items-end">
            <label className="text-sm">Desde<input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="block mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" /></label>
            <label className="text-sm">Hasta<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="block mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" /></label>
            <label className="text-sm">Usuario
              <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} className="block mt-1 border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                <option value="">Todos</option>
                {users.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
              </select>
            </label>
            <button onClick={loadReport} className="px-4 py-2 bg-emerald-600 text-white rounded-lg text-sm border-none cursor-pointer hover:bg-emerald-700">Calcular</button>
          </div>

          {report && (
            <>
              <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                <p className="text-xs text-emerald-700 uppercase font-semibold">Total comisiones</p>
                <p className="text-3xl font-bold text-emerald-800">${Number(report.total).toFixed(2)}</p>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600"><tr>
                    <th className="text-left px-3 py-2">Usuario</th>
                    <th className="text-right px-3 py-2">Servicios</th>
                    <th className="text-right px-3 py-2">Comisión</th>
                  </tr></thead>
                  <tbody>
                    {report.byUser.length === 0 && <tr><td colSpan={3} className="text-center py-6 text-slate-400">Sin comisiones en el período</td></tr>}
                    {report.byUser.map((u) => (
                      <tr key={u.userId} className="border-t border-slate-100">
                        <td className="px-3 py-2">{u.userName}</td>
                        <td className="px-3 py-2 text-right">{u.count}</td>
                        <td className="px-3 py-2 text-right font-semibold text-emerald-700">${Number(u.total).toFixed(2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Editar regla' : 'Nueva regla de comisión'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm">Nombre de la regla
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" required />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">Aplica a
              <select value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <option value="role">Un rol</option>
                <option value="user">Un usuario específico</option>
              </select>
            </label>
            {form.targetType === 'role' ? (
              <label className="block text-sm">Rol
                <select
                  value={form.role}
                  onChange={(e) => {
                    const role = e.target.value;
                    const opts = triggersForRole(role);
                    setForm({ ...form, role, trigger: opts.includes(form.trigger) ? form.trigger : opts[0] });
                  }}
                  className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
                >
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
            ) : (
              <label className="block text-sm">Usuario
                <select value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                  <option value="">— Seleccionar —</option>
                  {users.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
                </select>
              </label>
            )}
          </div>

          {/* Evento que devenga la comisión — se adapta al rol elegido */}
          <label className="block text-sm">¿Cuándo se gana la comisión?
            <select
              value={form.trigger}
              onChange={(e) => setForm({ ...form, trigger: e.target.value })}
              className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm"
            >
              {(form.targetType === 'role' ? triggersForRole(form.role) : ALL_TRIGGERS).map((t) => (
                <option key={t} value={t}>{TRIGGERS[t]}</option>
              ))}
            </select>
            <span className="block mt-1 text-xs text-slate-400">
              {form.trigger === 'appointment_created'
                ? 'Ej.: el call center gana esta comisión cuando una cita que agendó se completa.'
                : form.trigger === 'recommendation'
                ? 'Se atribuye a quien figure como "recomendado por" en la venta.'
                : form.trigger === 'sale'
                ? 'Se gana al registrar la venta del producto/servicio.'
                : 'Se gana al atender (doctor/enfermero) la cita que se completa.'}
            </span>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">Producto / Servicio / Ítem
              <select value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <option value="">Cualquier producto/servicio</option>
                {services.map((s) => (
                  <option key={s._id} value={s._id}>
                    {s.name} {s.category ? `(${s.category})` : ''}
                  </option>
                ))}
              </select>
            </label>
            <label className="block text-sm">Pacientes
              <select value={form.patientScope} onChange={(e) => setForm({ ...form, patientScope: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <option value="all">Todos los pacientes</option>
                <option value="new">Solo pacientes nuevos</option>
              </select>
            </label>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block text-sm">Monto de la comisión ($)
              <input type="number" step="0.01" min="0" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" required />
            </label>
            <label className="block text-sm">Cuenta contable (gasto comisión)
              <select value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm">
                <option value="">Sin asignar</option>
                {accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}
              </select>
            </label>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.scheduleEnabled} onChange={(e) => setForm({ ...form, scheduleEnabled: e.target.checked })} className="w-4 h-4 accent-emerald-600" />
            Aplicar solo en un horario específico
          </label>
          {form.scheduleEnabled && (
            <div className="bg-slate-50 rounded-lg p-3 space-y-2">
              <div className="flex flex-wrap gap-1">
                {DAYS.map((d) => {
                  const on = form.daysOfWeek.includes(d.v);
                  return (
                    <button key={d.v} type="button"
                      onClick={() => setForm({ ...form, daysOfWeek: on ? form.daysOfWeek.filter((x) => x !== d.v) : [...form.daysOfWeek, d.v] })}
                      className={`px-2 py-1 rounded text-xs border cursor-pointer ${on ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>
                      {d.l}
                    </button>
                  );
                })}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <label className="block text-sm">Desde<input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" /></label>
                <label className="block text-sm">Hasta<input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-lg px-3 py-2 text-sm" /></label>
              </div>
            </div>
          )}
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} className="w-4 h-4 accent-emerald-600" />
            Regla activa
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setModal(false)} className="px-4 py-2 rounded-lg border border-slate-200 bg-white cursor-pointer">Cancelar</button>
            <button type="submit" disabled={saving} className="px-4 py-2 rounded-lg bg-emerald-600 text-white border-none cursor-pointer hover:bg-emerald-700 disabled:opacity-50">{saving ? 'Guardando...' : 'Guardar'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
