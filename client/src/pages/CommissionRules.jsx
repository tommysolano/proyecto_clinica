import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { HiOutlinePlus, HiOutlineTrash, HiOutlinePencil, HiOutlineTrophy, HiOutlineArrowDownTray, HiOutlineBanknotes } from 'react-icons/hi2';
import NumericInput from '../components/NumericInput';

const ROLES = [
  { value: 'admin', label: 'Administrador' },
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
  appointment_created: 'Cuando una cita que agendó es asistida/completada',
  sale: 'Cuando registra una venta',
  recommendation: 'Cuando recomienda un producto/servicio vendido',
  referral: 'Cuando deriva un paciente y la cita derivada se completa',
  admin_service: 'Por cada servicio atendido en la clínica',
  call_center_commission: 'Cuando su call center ligado gana comisión',
};

// Triggers sugeridos según el rol seleccionado (el modal se adapta al rol).
const TRIGGERS_BY_ROLE = {
  admin: ['admin_service'],
  doctor: ['appointment_performed', 'recommendation', 'referral'],
  optica: ['appointment_performed', 'recommendation'],
  enfermero: ['appointment_performed', 'recommendation'],
  cajero: ['sale', 'recommendation'],
  call_center: ['appointment_created', 'recommendation'],
  marketing: ['call_center_commission', 'appointment_created', 'sale', 'recommendation'],
};
const ALL_TRIGGERS = Object.keys(TRIGGERS);

const triggersForRole = (role) => TRIGGERS_BY_ROLE[role] || ALL_TRIGGERS;
const DAYS = [
  { v: 1, l: 'Lun' }, { v: 2, l: 'Mar' }, { v: 3, l: 'Mié' }, { v: 4, l: 'Jue' },
  { v: 5, l: 'Vie' }, { v: 6, l: 'Sáb' }, { v: 0, l: 'Dom' },
];

const ROLE_LABELS = {
  admin: 'Administrador', doctor: 'Doctor', optica: 'Óptica', enfermero: 'Enfermero/a',
  cajero: 'Cajero', call_center: 'Call Center', marketing: 'Marketing',
};

function downloadCsv(rows, filename) {
  const escape = (v) => {
    const s = v == null ? '' : String(v);
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = rows.map((r) => r.map(escape).join(',')).join('\r\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const EMPTY = {
  name: '', active: true, targetType: 'role', user: '', role: 'doctor',
  trigger: 'appointment_performed',
  service: '', patientScope: 'all', scheduleEnabled: false, daysOfWeek: [],
  startTime: '', endTime: '',
  amountType: 'fixed', amount: '', percent: '',
  multiService: false, serviceAmounts: [],
  linkedCallCenter: '',
  account: '',
};

// Fila vacía del editor multi-servicio.
const EMPTY_SVC = { service: '', amountType: 'fixed', amount: '', percent: '' };

// Etiqueta del monto de una regla para la tabla.
const ruleAmountLabel = (r) => {
  if ((r.serviceAmounts || []).length) return `${r.serviceAmounts.length} servicios`;
  if (r.amountType === 'percent') return Number(r.percent) > 0 ? `${Number(r.percent)}%` : 'Por conteo';
  return Number(r.amount) > 0 ? `$${Number(r.amount).toFixed(2)}` : 'Por conteo';
};

// Selector $ Fijo / % Porcentaje.
function ModeToggle({ value, onChange }) {
  return (
    <div className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-xs shrink-0">
      {[['fixed', '$ Fijo'], ['percent', '%']].map(([v, l]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={`px-2.5 py-1 cursor-pointer border-none ${value === v ? 'bg-emerald-600 text-white' : 'bg-white text-slate-600'}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export default function CommissionRules() {
  const [tab, setTab] = useState('rules');
  const [rules, setRules] = useState([]);
  const [users, setUsers] = useState([]);
  const [agents, setAgents] = useState([]); // agentes call center (para marketing ligado)
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
  const [filterMode, setFilterMode] = useState('all'); // 'all' | 'user' | 'role'
  const [userFilter, setUserFilter] = useState('');
  const [roleFilter, setRoleFilter] = useState('');
  const [report, setReport] = useState(null);
  const [posting, setPosting] = useState(false);

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
      api.get('/call-center/agents').then((g) => setAgents(g.data || [])).catch(() => {});
      api.get('/chart-of-accounts', { params: { active: true } }).then((a) => setAccounts((a.data || []).filter((x) => x.allowsMovement))).catch(() => {});
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al cargar');
    }
  };
  useEffect(() => { load(); }, []);

  const loadReport = async () => {
    try {
      const params = { start, end };
      if (filterMode === 'user' && userFilter) params.user = userFilter;
      if (filterMode === 'role' && roleFilter) params.role = roleFilter;
      const res = await api.get('/commissions/report', { params });
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
      startTime: r.startTime || '', endTime: r.endTime || '',
      amountType: r.amountType || 'fixed',
      amount: r.amount ? String(r.amount) : '',
      percent: r.percent ? String(r.percent) : '',
      multiService: (r.serviceAmounts || []).length > 0,
      serviceAmounts: (r.serviceAmounts || []).map((sa) => ({
        service: sa.service?._id || sa.service || '',
        amountType: sa.amountType || 'fixed',
        amount: sa.amount ? String(sa.amount) : '',
        percent: sa.percent ? String(sa.percent) : '',
      })),
      linkedCallCenter: r.linkedCallCenter?._id || r.linkedCallCenter || '',
      account: r.account?._id || r.account || '',
    });
    setModal(true);
  };

  // ¿La regla aplica al call center? (por rol o por el usuario elegido).
  // Para el call center NO se filtra por producto/servicio.
  const selectedUser = users.find((u) => u._id === form.user);
  const userIsCallCenter = (selectedUser?.clinics || []).some((c) => c.role === 'call_center');
  const isCallCenter = form.targetType === 'role' ? form.role === 'call_center' : userIsCallCenter;
  // Marketing ligado a un call center (gana sobre la comisión del agente).
  const isMarketingLink = form.trigger === 'call_center_commission';
  // Triggers que comisionan por SERVICIO (admiten varios servicios con montos distintos).
  const canMultiService = ['appointment_performed', 'admin_service', 'sale', 'recommendation'].includes(form.trigger);
  const usingMulti = canMultiService && form.multiService;
  // Mostrar el selector de un servicio único.
  const showSingleService = !isCallCenter && !isMarketingLink && !usingMulti;

  // Helpers del editor multi-servicio.
  const addSvcRow = () => setForm((f) => ({ ...f, serviceAmounts: [...f.serviceAmounts, { ...EMPTY_SVC }] }));
  const updateSvcRow = (i, patch) =>
    setForm((f) => ({ ...f, serviceAmounts: f.serviceAmounts.map((r, idx) => (idx === i ? { ...r, ...patch } : r)) }));
  const removeSvcRow = (i) =>
    setForm((f) => ({ ...f, serviceAmounts: f.serviceAmounts.filter((_, idx) => idx !== i) }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.name) { toast.error('El nombre es obligatorio'); return; }
    if (isMarketingLink && !form.linkedCallCenter) { toast.error('Selecciona el call center al que está ligado'); return; }
    if (usingMulti && form.serviceAmounts.filter((s) => s.service).length === 0) {
      toast.error('Agrega al menos un servicio con su monto'); return;
    }
    setSaving(true);
    try {
      const serviceAmounts = usingMulti
        ? form.serviceAmounts
            .filter((s) => s.service)
            .map((s) => ({
              service: s.service,
              amountType: s.amountType,
              amount: parseFloat(s.amount) || 0,
              percent: parseFloat(s.percent) || 0,
            }))
        : [];
      const body = {
        ...form,
        amountType: form.amountType,
        amount: parseFloat(form.amount) || 0,
        percent: parseFloat(form.percent) || 0,
        serviceAmounts,
        user: form.targetType === 'user' ? form.user : null,
        role: form.targetType === 'role' ? form.role : '',
        // En reglas multi-servicio el servicio único se ignora.
        service: isCallCenter || isMarketingLink || usingMulti ? null : (form.service || null),
        linkedCallCenter: isMarketingLink ? (form.linkedCallCenter || null) : null,
        account: form.account || null,
      };
      delete body.multiService;
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

  const downloadSummary = () => {
    if (!report) return;
    const hasValues = Number(report.total) > 0;
    const header = ['Usuario', 'Comisiones', ...(hasValues ? ['Valor ($)'] : [])];
    const rows = report.byUser.map((u) => [
      u.userName,
      u.count,
      ...(hasValues ? [Number(u.total).toFixed(2)] : []),
    ]);
    downloadCsv([header, ...rows], `comisiones_resumen_${start}_${end}.csv`);
  };

  const downloadDetail = () => {
    if (!report) return;
    const header = ['Fecha', 'Usuario', 'Rol', 'Regla', 'Servicio', 'Paciente', 'Origen', 'Valor ($)'];
    const rows = report.detail.map((d) => [
      d.date ? new Date(d.date).toLocaleDateString('es-EC') : '',
      d.userName,
      ROLE_LABELS[d.userRole] || d.userRole || '',
      d.ruleName,
      d.service,
      d.patient,
      d.source,
      Number(d.amount || 0).toFixed(2),
    ]);
    downloadCsv([header, ...rows], `comisiones_detalle_${start}_${end}.csv`);
  };

  const remove = async (id) => {
    if (!confirm('¿Eliminar esta regla?')) return;
    try { await api.delete(`/commissions/rules/${id}`); toast.success('Eliminada'); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  // Contabiliza las comisiones del período: genera el asiento contable
  // (Débito gasto comisiones / Crédito comisiones por pagar al personal).
  const contabilizar = async () => {
    if (!confirm(`¿Contabilizar las comisiones del ${start} al ${end}? Se generará un asiento contable por $${Number(report?.total || 0).toFixed(2)}.`)) return;
    setPosting(true);
    try {
      const res = await api.post('/commissions/post', { start, end });
      toast.success(`Comisiones contabilizadas (asiento ${res.data?.journalEntry?.number || ''})`);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error al contabilizar');
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineTrophy className="text-emerald-600" /> Comisiones
        </h1>
        {tab === 'rules' && (
          <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 hover:bg-emerald-700 border-none cursor-pointer">
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
          <table className="tbl">
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
                  <td className="px-3 py-2">{
                    (r.serviceAmounts || []).length
                      ? `${r.serviceAmounts.length} servicios`
                      : r.trigger === 'call_center_commission'
                      ? `Call center: ${r.linkedCallCenter?.name || '—'}`
                      : r.service?.name || 'Cualquier servicio'
                  }</td>
                  <td className="px-3 py-2">{r.patientScope === 'new' ? 'Solo nuevos' : 'Todos'}</td>
                  <td className="px-3 py-2 text-right">{ruleAmountLabel(r) === 'Por conteo'
                    ? <span className="text-slate-400">Por conteo</span>
                    : ruleAmountLabel(r)}</td>
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
            <label className="text-sm">Desde<input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" /></label>
            <label className="text-sm">Hasta<input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm" /></label>
            <label className="text-sm">Filtrar por
              <select
                value={filterMode}
                onChange={(e) => { setFilterMode(e.target.value); setUserFilter(''); setRoleFilter(''); }}
                className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm"
              >
                <option value="all">Todos</option>
                <option value="user">Usuario específico</option>
                <option value="role">Rol</option>
              </select>
            </label>
            {filterMode === 'user' && (
              <label className="text-sm">Usuario
                <select value={userFilter} onChange={(e) => setUserFilter(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm">
                  <option value="">— Seleccionar —</option>
                  {users.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
                </select>
              </label>
            )}
            {filterMode === 'role' && (
              <label className="text-sm">Rol
                <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="block mt-1 border border-slate-200 rounded-xl px-2 py-1.5 text-sm">
                  <option value="">— Seleccionar —</option>
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
            )}
            <button onClick={loadReport} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm border-none cursor-pointer hover:bg-emerald-700">Calcular</button>
          </div>

          {report && (() => {
            // Si no hay montos asignados ($0 en total), mostramos solo el conteo
            // de comisiones generadas; si hay valores, también mostramos los $.
            const hasValues = Number(report.total) > 0;
            const totalCount = (report.byUser || []).reduce((a, u) => a + (u.count || 0), 0);
            return (
              <>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="bg-sky-50 border border-sky-200 rounded-xl p-4">
                    <p className="text-xs text-sky-700 uppercase font-semibold">Comisiones generadas</p>
                    <p className="text-3xl font-bold text-sky-800">{totalCount}</p>
                  </div>
                  {hasValues && (
                    <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                      <p className="text-xs text-emerald-700 uppercase font-semibold">Total comisiones</p>
                      <p className="text-3xl font-bold text-emerald-800">${Number(report.total).toFixed(2)}</p>
                    </div>
                  )}
                </div>
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-slate-600">Resumen por usuario</p>
                  <div className="flex gap-2">
                    {hasValues && (
                      <button
                        onClick={contabilizar}
                        disabled={posting}
                        title="Genera el asiento contable de las comisiones del período"
                        className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-white bg-emerald-600 border border-emerald-600 rounded-lg hover:bg-emerald-700 cursor-pointer border-solid disabled:opacity-50"
                      >
                        <HiOutlineBanknotes className="w-3.5 h-3.5" />
                        {posting ? 'Contabilizando...' : 'Contabilizar período'}
                      </button>
                    )}
                    <button
                      onClick={downloadSummary}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 cursor-pointer border-solid"
                    >
                      <HiOutlineArrowDownTray className="w-3.5 h-3.5" />
                      Descargar vista
                    </button>
                    <button
                      onClick={downloadDetail}
                      className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-slate-700 bg-slate-50 border border-slate-200 rounded-lg hover:bg-slate-100 cursor-pointer border-solid"
                    >
                      <HiOutlineArrowDownTray className="w-3.5 h-3.5" />
                      Descargar detalle completo
                    </button>
                  </div>
                </div>
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
                  <table className="tbl">
                    <thead className="bg-slate-50 text-slate-600"><tr>
                      <th className="text-left px-3 py-2">Usuario</th>
                      <th className="text-right px-3 py-2">Comisiones</th>
                      {hasValues && <th className="text-right px-3 py-2">Valor</th>}
                    </tr></thead>
                    <tbody>
                      {report.byUser.length === 0 && <tr><td colSpan={hasValues ? 3 : 2} className="text-center py-6 text-slate-400">Sin comisiones en el período</td></tr>}
                      {report.byUser.map((u) => (
                        <tr key={u.userId} className="border-t border-slate-100">
                          <td className="px-3 py-2">{u.userName}</td>
                          <td className="px-3 py-2 text-right">{u.count}</td>
                          {hasValues && <td className="px-3 py-2 text-right font-semibold text-emerald-700">${Number(u.total).toFixed(2)}</td>}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            );
          })()}
        </div>
      )}

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Editar regla' : 'Nueva regla de comisión'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <label className="block text-sm">Nombre de la regla
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" required />
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="block text-sm">Aplica a
              <select value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
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
                  className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
                >
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </label>
            ) : (
              <label className="block text-sm">Usuario
                <select value={form.user} onChange={(e) => setForm({ ...form, user: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
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
              className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm"
            >
              {(form.targetType === 'role' ? triggersForRole(form.role) : ALL_TRIGGERS).map((t) => (
                <option key={t} value={t}>{TRIGGERS[t]}</option>
              ))}
            </select>
            <span className="block mt-1 text-xs text-slate-400">
              {form.trigger === 'appointment_created'
                ? 'El call center gana cuando una cita que agendó es asistida/completada. Se cuenta una vez por cita.'
                : form.trigger === 'recommendation'
                ? 'Se atribuye a quien figure como "recomendado por" en la venta.'
                : form.trigger === 'sale'
                ? 'Se gana al registrar la venta del producto/servicio.'
                : form.trigger === 'referral'
                ? 'El doctor que derivó al paciente gana cuando la cita derivada se completa.'
                : form.trigger === 'admin_service'
                ? 'El administrador gana por cada servicio atendido. Usa "varios servicios" para distinto monto por servicio.'
                : form.trigger === 'call_center_commission'
                ? 'El marketing gana en función de la comisión que devengue el call center al que está ligado.'
                : 'Se gana al atender (doctor/enfermero) la cita que se completa.'}
            </span>
          </label>
          {/* Marketing ligado a un call center */}
          {isMarketingLink && (
            <label className="block text-sm">Call center al que está ligado
              <select value={form.linkedCallCenter} onChange={(e) => setForm({ ...form, linkedCallCenter: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                <option value="">— Seleccionar agente —</option>
                {agents.map((a) => <option key={a._id} value={a._id}>{a.name}</option>)}
              </select>
              <span className="block mt-1 text-xs text-slate-400">El marketing ganará en función de lo que devengue este agente en el período.</span>
            </label>
          )}

          <div className="grid grid-cols-2 gap-3">
            {/* Call center y marketing-ligado no se filtran por producto. */}
            {showSingleService && (
              <label className="block text-sm">Producto / Servicio / Ítem
                <select value={form.service} onChange={(e) => setForm({ ...form, service: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                  <option value="">Cualquier producto/servicio</option>
                  {services.map((s) => (
                    <option key={s._id} value={s._id}>
                      {s.name} {s.category ? `(${s.category})` : ''}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {!isMarketingLink && (
              <label className="block text-sm">Pacientes
                <select value={form.patientScope} onChange={(e) => setForm({ ...form, patientScope: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                  <option value="all">Todos los pacientes</option>
                  <option value="new">Solo pacientes nuevos</option>
                </select>
              </label>
            )}
          </div>

          {/* Varios servicios con montos distintos (admin, etc.) */}
          {canMultiService && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.multiService}
                onChange={(e) => setForm({
                  ...form,
                  multiService: e.target.checked,
                  serviceAmounts: e.target.checked && form.serviceAmounts.length === 0 ? [{ ...EMPTY_SVC }] : form.serviceAmounts,
                })}
                className="w-4 h-4 accent-emerald-600"
              />
              Varios servicios con montos distintos
            </label>
          )}

          {usingMulti ? (
            <div className="bg-slate-50 rounded-lg p-3 space-y-2">
              {form.serviceAmounts.map((row, i) => (
                <div key={i} className="flex flex-wrap items-center gap-2 bg-white border border-slate-200 rounded-lg p-2">
                  <select value={row.service} onChange={(e) => updateSvcRow(i, { service: e.target.value })} className="flex-1 min-w-[180px] border border-slate-200 rounded-lg px-2 py-1.5 text-sm">
                    <option value="">— Servicio —</option>
                    {services.map((s) => <option key={s._id} value={s._id}>{s.name} {s.category ? `(${s.category})` : ''}</option>)}
                  </select>
                  <ModeToggle value={row.amountType} onChange={(v) => updateSvcRow(i, { amountType: v })} />
                  {row.amountType === 'percent' ? (
                    <NumericInput step="0.01" min="0" max="100" placeholder="%" value={row.percent} onChange={(e) => updateSvcRow(i, { percent: e.target.value })} className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                  ) : (
                    <NumericInput step="0.01" min="0" placeholder="$" value={row.amount} onChange={(e) => updateSvcRow(i, { amount: e.target.value })} className="w-24 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                  )}
                  <button type="button" onClick={() => removeSvcRow(i)} className="p-1 text-slate-400 hover:text-red-600 bg-transparent border-none cursor-pointer"><HiOutlineTrash className="w-4 h-4" /></button>
                </div>
              ))}
              <button type="button" onClick={addSvcRow} className="flex items-center gap-1 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-1.5 cursor-pointer border-solid">
                <HiOutlinePlus className="w-3.5 h-3.5" /> Agregar servicio
              </button>
              <label className="block text-sm pt-1">Cuenta contable (gasto comisión)
                <select value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                  <option value="">Sin asignar</option>
                  {accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}
                </select>
              </label>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span>{form.amountType === 'percent' ? 'Porcentaje de comisión' : 'Monto de la comisión ($)'} <span className="text-slate-400 font-normal">(opcional)</span></span>
                  <ModeToggle value={form.amountType} onChange={(v) => setForm({ ...form, amountType: v })} />
                </div>
                {form.amountType === 'percent' ? (
                  <NumericInput step="0.01" min="0" max="100" placeholder="0 — % sobre lo que paga el paciente" value={form.percent} onChange={(e) => setForm({ ...form, percent: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
                ) : (
                  <NumericInput step="0.01" min="0" placeholder="0.00 — déjalo vacío para contar sin valor" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
                )}
                {isMarketingLink && (
                  <span className="block mt-1 text-xs text-slate-400">{form.amountType === 'percent' ? '% sobre la comisión total del agente.' : '$ por cada comisión que genere el agente.'}</span>
                )}
              </div>
              <label className="block text-sm">Cuenta contable (gasto comisión)
                <select value={form.account} onChange={(e) => setForm({ ...form, account: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm">
                  <option value="">Sin asignar</option>
                  {accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}
                </select>
              </label>
            </div>
          )}
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
                <label className="block text-sm">Desde<input type="time" value={form.startTime} onChange={(e) => setForm({ ...form, startTime: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" /></label>
                <label className="block text-sm">Hasta<input type="time" value={form.endTime} onChange={(e) => setForm({ ...form, endTime: e.target.value })} className="block w-full mt-1 border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" /></label>
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
