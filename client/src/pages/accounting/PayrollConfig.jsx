import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCog6Tooth, HiOutlinePlus } from 'react-icons/hi2';
import NumericInput from '../../components/NumericInput';

const ACCOUNT_LABELS = {
  sueldos: 'Gasto sueldos (general)',
  beneficios: 'Gasto beneficios sociales',
  iessPatronal: 'Gasto aporte patronal',
  gastoVacaciones: 'Gasto vacaciones',
  iessPorPagar: 'IESS por pagar',
  sueldosPorPagar: 'Sueldos por pagar',
  irPorPagar: 'Impuesto a la renta por pagar',
  prestamosPorCobrar: 'Préstamos empleados por cobrar',
  cxcEmpleados: 'CxC empleados (deducciones)',
  provisionesPorPagar: 'Provisiones por pagar',
  decimoTerceroPorPagar: 'Décimo tercero por pagar',
  decimoCuartoPorPagar: 'Décimo cuarto por pagar',
  fondosReservaPorPagar: 'Fondos de reserva por pagar',
  vacacionesPorPagar: 'Vacaciones por pagar',
};

const inputCls = 'border border-slate-200 rounded-xl px-3.5 py-2.5 w-full';
const TABS = [['params', 'Parámetros'], ['accounts', 'Cuentas'], ['depts', 'Departamentos'], ['positions', 'Cargos'], ['concepts', 'Conceptos']];

export default function PayrollConfig() {
  const [tab, setTab] = useState('params');
  const [cfg, setCfg] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [depts, setDepts] = useState([]);
  const [positions, setPositions] = useState([]);
  const [concepts, setConcepts] = useState([]);

  const loadCfg = () => api.get('/payroll/config').then((r) => setCfg(r.data)).catch((e) => toast.error(e.response?.data?.message || 'Error'));
  const loadDepts = () => api.get('/payroll/departments').then((r) => setDepts(r.data || [])).catch(() => {});
  const loadPositions = () => api.get('/payroll/positions').then((r) => setPositions(r.data || [])).catch(() => {});
  const loadConcepts = () => api.get('/payroll/concepts').then((r) => setConcepts(r.data || [])).catch(() => {});
  useEffect(() => {
    loadCfg(); loadDepts(); loadPositions(); loadConcepts();
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement))).catch(() => {});
  }, []);

  const saveCfg = async () => {
    try { const r = await api.put('/payroll/config', cfg); setCfg(r.data); toast.success('Configuración guardada'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  if (!cfg) return <div className="p-8 text-slate-400">Cargando...</div>;
  const num = (k) => (e) => setCfg({ ...cfg, [k]: +e.target.value });

  return (
    <div className="space-y-4 max-w-4xl">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCog6Tooth className="text-emerald-600" /> Configuración de Nómina</h1>
      <div className="flex gap-2 flex-wrap">
        {TABS.map(([k, l]) => <button key={k} onClick={() => setTab(k)} className={`px-3 py-2 rounded-lg text-xs ${tab === k ? 'bg-emerald-600 text-white' : 'bg-white border'}`}>{l}</button>)}
      </div>

      {tab === 'params' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
          <h2 className="font-semibold text-slate-700">Parámetros (porcentajes configurables)</h2>
          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Frecuencia de pago</span>
              <select value={cfg.paymentFrequency} onChange={(e) => setCfg({ ...cfg, paymentFrequency: e.target.value })} className={inputCls}><option value="MENSUAL">Mensual</option><option value="QUINCENAL">Quincenal</option></select>
            </label>
            <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">SBU (Salario Básico Unificado)</span><NumericInput step="0.01" value={cfg.sbu} onChange={num('sbu')} className={inputCls} /></label>
            <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% IESS personal</span><NumericInput step="0.01" value={cfg.iessPersonal} onChange={num('iessPersonal')} className={inputCls} /></label>
            <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% IESS patronal</span><NumericInput step="0.01" value={cfg.iessPatronal} onChange={num('iessPatronal')} className={inputCls} /></label>
            <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% IECE</span><NumericInput step="0.01" value={cfg.iece} onChange={num('iece')} className={inputCls} /></label>
            <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% SECAP</span><NumericInput step="0.01" value={cfg.secap} onChange={num('secap')} className={inputCls} /></label>
            <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% Fondos de reserva</span><NumericInput step="0.01" value={cfg.fondosReserva} onChange={num('fondosReserva')} className={inputCls} /></label>
          </div>
          <button onClick={saveCfg} className="px-5 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button>
        </div>
      )}

      {tab === 'accounts' && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
          <h2 className="font-semibold text-slate-700">Cuentas contables generales (fallback si el departamento no define la suya)</h2>
          <div className="grid grid-cols-2 gap-3">
            {Object.keys(ACCOUNT_LABELS).map((k) => (
              <label key={k} className="text-xs flex flex-col gap-1"><span className="text-slate-600">{ACCOUNT_LABELS[k]}</span>
                <input value={cfg.accounts?.[k] || ''} onChange={(e) => setCfg({ ...cfg, accounts: { ...cfg.accounts, [k]: e.target.value } })} className={inputCls} placeholder="Código del plan" />
              </label>
            ))}
          </div>
          <button onClick={saveCfg} className="px-5 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button>
        </div>
      )}

      {tab === 'depts' && <Departments accounts={accounts} depts={depts} reload={loadDepts} />}
      {tab === 'positions' && <Positions depts={depts} positions={positions} reload={loadPositions} />}
      {tab === 'concepts' && <Concepts accounts={accounts} concepts={concepts} reload={loadConcepts} />}
    </div>
  );
}

const accLabel = (a) => `${a.code} · ${a.name}`;
function AccountSelect({ value, onChange, accounts, placeholder = 'Sin cuenta' }) {
  return (
    <select value={value || ''} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">{placeholder}</option>
      {accounts.map((a) => <option key={a._id} value={a._id}>{accLabel(a)}</option>)}
    </select>
  );
}

// ---- Departamentos ----
function Departments({ accounts, depts, reload }) {
  const EMPTY = { name: '', type: 'ADMINISTRATIVO', accounts: { sueldos: '', beneficios: '', iessPatronal: '' } };
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);

  const save = async () => {
    try {
      const payload = { ...form, accounts: { ...form.accounts } };
      if (editing) await api.put(`/payroll/departments/${editing}`, payload);
      else await api.post('/payroll/departments', payload);
      toast.success('Guardado'); setForm(EMPTY); setEditing(null); reload();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const edit = (d) => { setEditing(d._id); setForm({ name: d.name, type: d.type, accounts: { sueldos: d.accounts?.sueldos?._id || '', beneficios: d.accounts?.beneficios?._id || '', iessPatronal: d.accounts?.iessPatronal?._id || '' } }); };

  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-4">
      <h2 className="font-semibold text-slate-700">Departamentos</h2>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Nombre</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Tipo (clasificación del gasto)</span>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={inputCls}><option>ADMINISTRATIVO</option><option>VENTAS</option><option>COSTOS</option><option>OTRO</option></select>
        </label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Cuenta gasto sueldos</span><AccountSelect value={form.accounts.sueldos} onChange={(v) => setForm({ ...form, accounts: { ...form.accounts, sueldos: v } })} accounts={accounts} /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Cuenta gasto beneficios</span><AccountSelect value={form.accounts.beneficios} onChange={(v) => setForm({ ...form, accounts: { ...form.accounts, beneficios: v } })} accounts={accounts} /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Cuenta gasto aporte patronal</span><AccountSelect value={form.accounts.iessPatronal} onChange={(v) => setForm({ ...form, accounts: { ...form.accounts, iessPatronal: v } })} accounts={accounts} /></label>
      </div>
      <div className="flex gap-2">
        <button onClick={save} className="px-4 py-2 bg-emerald-600 text-white rounded-xl flex items-center gap-1"><HiOutlinePlus /> {editing ? 'Actualizar' : 'Agregar'}</button>
        {editing && <button onClick={() => { setEditing(null); setForm(EMPTY); }} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>}
      </div>
      <table className="tbl text-sm">
        <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Nombre</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Cuenta sueldos</th><th></th></tr></thead>
        <tbody>
          {depts.map((d) => (
            <tr key={d._id} className="border-t">
              <td className="px-3 py-2">{d.name}</td>
              <td className="px-3 py-2 text-xs">{d.type}</td>
              <td className="px-3 py-2 text-xs">{d.accounts?.sueldos ? `${d.accounts.sueldos.code} ${d.accounts.sueldos.name}` : <span className="text-amber-600">⚠ sin cuenta</span>}</td>
              <td className="px-3 py-2 text-right"><button onClick={() => edit(d)} className="text-blue-600 text-xs">Editar</button></td>
            </tr>
          ))}
          {depts.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-center text-slate-400">Sin departamentos.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---- Cargos ----
function Positions({ depts, positions, reload }) {
  const EMPTY = { name: '', department: '' };
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const save = async () => {
    try {
      if (editing) await api.put(`/payroll/positions/${editing}`, form);
      else await api.post('/payroll/positions', form);
      toast.success('Guardado'); setForm(EMPTY); setEditing(null); reload();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-4">
      <h2 className="font-semibold text-slate-700">Cargos</h2>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Nombre</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Departamento</span>
          <select value={form.department || ''} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputCls}><option value="">Sin departamento</option>{depts.map((d) => <option key={d._id} value={d._id}>{d.name}</option>)}</select>
        </label>
      </div>
      <div className="flex gap-2">
        <button onClick={save} className="px-4 py-2 bg-emerald-600 text-white rounded-xl flex items-center gap-1"><HiOutlinePlus /> {editing ? 'Actualizar' : 'Agregar'}</button>
        {editing && <button onClick={() => { setEditing(null); setForm(EMPTY); }} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>}
      </div>
      <table className="tbl text-sm">
        <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Cargo</th><th className="px-3 py-2 text-left">Departamento</th><th></th></tr></thead>
        <tbody>
          {positions.map((p) => (
            <tr key={p._id} className="border-t">
              <td className="px-3 py-2">{p.name}</td>
              <td className="px-3 py-2 text-xs">{p.department?.name || '—'}</td>
              <td className="px-3 py-2 text-right"><button onClick={() => { setEditing(p._id); setForm({ name: p.name, department: p.department?._id || '' }); }} className="text-blue-600 text-xs">Editar</button></td>
            </tr>
          ))}
          {positions.length === 0 && <tr><td colSpan={3} className="px-3 py-4 text-center text-slate-400">Sin cargos.</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---- Conceptos (rubros) ----
function Concepts({ accounts, concepts, reload }) {
  const EMPTY = { code: '', name: '', type: 'INGRESO', category: '', rate: 0, defaultAccount: '', payableAccount: '', active: true };
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const save = async () => {
    try {
      if (editing) await api.put(`/payroll/concepts/${editing}`, form);
      else await api.post('/payroll/concepts', form);
      toast.success('Guardado'); setForm(EMPTY); setEditing(null); reload();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const seed = async () => {
    if (!confirm('¿Sembrar el catálogo estándar de conceptos? No duplica los existentes.')) return;
    try { const r = await api.post('/payroll/concepts/seed'); toast.success(`Creados ${r.data.created}`); reload(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-semibold text-slate-700">Conceptos / rubros</h2>
        <button onClick={seed} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs">Sembrar estándar</button>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Código</span><input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Nombre</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Tipo</span>
          <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className={inputCls}><option>INGRESO</option><option>EGRESO</option><option>PROVISION</option><option>OBLIGACION</option></select>
        </label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% (opcional)</span><NumericInput step="0.01" value={form.rate} onChange={(e) => setForm({ ...form, rate: +e.target.value })} className={inputCls} /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Cuenta gasto (ingreso/provisión)</span><AccountSelect value={form.defaultAccount} onChange={(v) => setForm({ ...form, defaultAccount: v })} accounts={accounts} /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Cuenta por pagar / CxC (egreso)</span><AccountSelect value={form.payableAccount} onChange={(v) => setForm({ ...form, payableAccount: v })} accounts={accounts} /></label>
      </div>
      <div className="flex gap-2">
        <button onClick={save} className="px-4 py-2 bg-emerald-600 text-white rounded-xl flex items-center gap-1"><HiOutlinePlus /> {editing ? 'Actualizar' : 'Agregar'}</button>
        {editing && <button onClick={() => { setEditing(null); setForm(EMPTY); }} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>}
      </div>
      <table className="tbl text-sm">
        <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Nombre</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Cuenta</th><th></th></tr></thead>
        <tbody>
          {concepts.map((c) => (
            <tr key={c._id} className="border-t">
              <td className="px-3 py-2 font-mono text-xs">{c.code}</td>
              <td className="px-3 py-2">{c.name}</td>
              <td className="px-3 py-2 text-xs">{c.type}</td>
              <td className="px-3 py-2 text-xs">{c.defaultAccount ? `${c.defaultAccount.code}` : (c.payableAccount ? `${c.payableAccount.code}` : <span className="text-slate-400">—</span>)}</td>
              <td className="px-3 py-2 text-right"><button onClick={() => { setEditing(c._id); setForm({ code: c.code, name: c.name, type: c.type, category: c.category || '', rate: c.rate || 0, defaultAccount: c.defaultAccount?._id || '', payableAccount: c.payableAccount?._id || '', active: c.active }); }} className="text-blue-600 text-xs">Editar</button></td>
            </tr>
          ))}
          {concepts.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-slate-400">Sin conceptos. Usa «Sembrar estándar».</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
