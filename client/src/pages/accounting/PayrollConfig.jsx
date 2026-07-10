import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCog6Tooth, HiOutlinePlus } from 'react-icons/hi2';
import NumericInput from '../../components/NumericInput';
import SharedAccountSelect from '../../components/AccountSelect';

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
const TABS = [['params', 'Parámetros'], ['accounts', 'Cuentas'], ['depts', 'Departamentos'], ['positions', 'Cargos'], ['concepts', 'Conceptos'], ['incometax', 'Impuesto Renta']];

export default function PayrollConfig() {
  const [tab, setTab] = useState('params');
  const [cfg, setCfg] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [depts, setDepts] = useState([]);
  const [positions, setPositions] = useState([]);
  const [concepts, setConcepts] = useState([]);
  const [irTables, setIrTables] = useState([]);

  const loadCfg = () => api.get('/payroll/config').then((r) => setCfg(r.data)).catch((e) => toast.error(e.response?.data?.message || 'Error'));
  const loadDepts = () => api.get('/payroll/departments').then((r) => setDepts(r.data || [])).catch(() => {});
  const loadPositions = () => api.get('/payroll/positions').then((r) => setPositions(r.data || [])).catch(() => {});
  const loadConcepts = () => api.get('/payroll/concepts').then((r) => setConcepts(r.data || [])).catch(() => {});
  const loadIrTables = () => api.get('/payroll/income-tax').then((r) => setIrTables(r.data || [])).catch(() => {});
  useEffect(() => {
    loadCfg(); loadDepts(); loadPositions(); loadConcepts(); loadIrTables();
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts(r.data || [])).catch(() => {});
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
      {tab === 'incometax' && <IncomeTax tables={irTables} reload={loadIrTables} />}
    </div>
  );
}

function AccountSelect({ value, onChange, accounts, placeholder = 'Sin cuenta' }) {
  return <SharedAccountSelect accounts={accounts} value={value || ''} onChange={onChange} emptyOption={placeholder} />;
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
const CONCEPT_RDEP_FLAGS = [
  ['isTaxableIncome', 'Ing. gravado'],
  ['isNonTaxableIncome', 'Ing. no gravado'],
  ['affectsIess', 'Aporta IESS'],
  ['affectsIncomeTax', 'Afecta IR'],
  ['affectsDecimos', 'Afecta decimos'],
  ['isDecimoTercero', 'Decimo tercero'],
  ['isDecimoCuarto', 'Decimo cuarto'],
  ['isFondosReserva', 'Fondos reserva'],
  ['isVacation', 'Vacaciones'],
  ['isReimbursement', 'Reembolso'],
  ['isOtherNonTaxable', 'Otro no gravado'],
  ['isDiscount', 'Descuento'],
  ['isPersonalIess', 'IESS personal'],
  ['isIncomeTaxWithholding', 'IR retenido'],
];

function Concepts({ accounts, concepts, reload }) {
  const flagDefaults = Object.fromEntries(CONCEPT_RDEP_FLAGS.map(([k]) => [k, false]));
  const EMPTY = { code: '', name: '', type: 'INGRESO', category: '', rate: 0, defaultAccount: '', payableAccount: '', active: true, ...flagDefaults };
  const [form, setForm] = useState(EMPTY);
  const [editing, setEditing] = useState(null);
  const toggleFlag = (k) => setForm({ ...form, [k]: !form[k] });
  const flagSummary = (c) => CONCEPT_RDEP_FLAGS.filter(([k]) => c[k]).map(([, label]) => label).join(', ');
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
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        {CONCEPT_RDEP_FLAGS.map(([k, label]) => (
          <label key={k} className="text-xs flex items-center gap-2 border border-slate-200 rounded-lg px-2 py-1.5 bg-slate-50">
            <input type="checkbox" checked={!!form[k]} onChange={() => toggleFlag(k)} />
            <span className="text-slate-700">{label}</span>
          </label>
        ))}
      </div>
      <div className="flex gap-2">
        <button onClick={save} className="px-4 py-2 bg-emerald-600 text-white rounded-xl flex items-center gap-1"><HiOutlinePlus /> {editing ? 'Actualizar' : 'Agregar'}</button>
        {editing && <button onClick={() => { setEditing(null); setForm(EMPTY); }} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>}
      </div>
      <table className="tbl text-sm">
        <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Nombre</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Cuenta</th><th className="px-3 py-2 text-left">Clasificación</th><th></th></tr></thead>
        <tbody>
          {concepts.map((c) => (
            <tr key={c._id} className="border-t">
              <td className="px-3 py-2 font-mono text-xs">{c.code}</td>
              <td className="px-3 py-2">{c.name}</td>
              <td className="px-3 py-2 text-xs">{c.type}</td>
              <td className="px-3 py-2 text-xs">{c.defaultAccount ? `${c.defaultAccount.code}` : (c.payableAccount ? `${c.payableAccount.code}` : <span className="text-slate-400">—</span>)}</td>
              <td className="px-3 py-2 text-[11px] text-slate-600 max-w-xs">{flagSummary(c) || <span className="text-amber-600">Sin clasificación RDEP</span>}</td>
              <td className="px-3 py-2 text-right"><button onClick={() => { setEditing(c._id); setForm({ code: c.code, name: c.name, type: c.type, category: c.category || '', rate: c.rate || 0, defaultAccount: c.defaultAccount?._id || '', payableAccount: c.payableAccount?._id || '', active: c.active, ...Object.fromEntries(CONCEPT_RDEP_FLAGS.map(([k]) => [k, !!c[k]])) }); }} className="text-blue-600 text-xs">Editar</button></td>
            </tr>
          ))}
          {concepts.length === 0 && <tr><td colSpan={6} className="px-3 py-4 text-center text-slate-400">Sin conceptos. Usa «Sembrar estándar».</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// ---- Tabla de impuesto a la renta (por año, rangos editables) ----
function IncomeTax({ tables, reload }) {
  const EMPTY_RANGE = { from: 0, to: '', baseTax: 0, excessRate: 0 };
  const [year, setYear] = useState(new Date().getFullYear());
  const [periodType, setPeriodType] = useState('ANNUAL');
  const [ranges, setRanges] = useState([{ ...EMPTY_RANGE }]);
  const [editing, setEditing] = useState(null);

  const setRange = (i, k, v) => setRanges(ranges.map((r, idx) => (idx === i ? { ...r, [k]: v } : r)));
  const addRange = () => setRanges([...ranges, { ...EMPTY_RANGE }]);
  const removeRange = (i) => setRanges(ranges.filter((_, idx) => idx !== i));

  const seed = async () => {
    try { const r = await api.post('/payroll/income-tax/seed', { year }); toast[r.data.created ? 'success' : 'error'](r.data.warning || 'Listo'); reload(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const save = async () => {
    try {
      const payload = { year: +year, periodType, active: true, ranges: ranges.map((r) => ({ from: +r.from || 0, to: r.to === '' || r.to == null ? null : +r.to, baseTax: +r.baseTax || 0, excessRate: +r.excessRate || 0 })) };
      if (editing) await api.put(`/payroll/income-tax/${editing}`, payload);
      else await api.post('/payroll/income-tax', payload);
      toast.success('Tabla guardada'); setEditing(null); setRanges([{ ...EMPTY_RANGE }]); reload();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const edit = (t) => { setEditing(t._id); setYear(t.year); setPeriodType(t.periodType); setRanges((t.ranges || []).map((r) => ({ from: r.from, to: r.to == null ? '' : r.to, baseTax: r.baseTax, excessRate: r.excessRate }))); };
  const toggle = async (t) => { try { await api.put(`/payroll/income-tax/${t._id}`, { active: !t.active }); reload(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };

  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-4">
      <div className="flex justify-between items-center">
        <h2 className="font-semibold text-slate-700">Impuesto a la renta (tabla por año)</h2>
        <button onClick={seed} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs">Sembrar tabla SRI 2024</button>
      </div>
      <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        Los rangos son configurables. La semilla usa la tabla SRI 2024: <b>valida/actualiza los valores vigentes</b> del año antes de declarar.
      </p>

      <div className="flex gap-3 items-end flex-wrap">
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Año</span><NumericInput value={year} onChange={(e) => setYear(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 w-24" /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Tipo</span>
          <select value={periodType} onChange={(e) => setPeriodType(e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5"><option value="ANNUAL">Anual</option><option value="MONTHLY">Mensual</option></select>
        </label>
      </div>

      <table className="tbl text-sm">
        <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-2 py-1 text-right">Desde</th><th className="px-2 py-1 text-right">Hasta</th><th className="px-2 py-1 text-right">Impuesto base</th><th className="px-2 py-1 text-right">% excedente</th><th></th></tr></thead>
        <tbody>
          {ranges.map((r, i) => (
            <tr key={i} className="border-t">
              <td className="px-2 py-1"><NumericInput value={r.from} onChange={(e) => setRange(i, 'from', e.target.value)} className="w-24 border rounded px-1 text-right" /></td>
              <td className="px-2 py-1"><input value={r.to} placeholder="∞" onChange={(e) => setRange(i, 'to', e.target.value)} className="w-24 border rounded px-1 text-right" /></td>
              <td className="px-2 py-1"><NumericInput value={r.baseTax} onChange={(e) => setRange(i, 'baseTax', e.target.value)} className="w-24 border rounded px-1 text-right" /></td>
              <td className="px-2 py-1"><NumericInput value={r.excessRate} onChange={(e) => setRange(i, 'excessRate', e.target.value)} className="w-20 border rounded px-1 text-right" /></td>
              <td className="px-2 py-1 text-right"><button onClick={() => removeRange(i)} className="text-rose-600 text-xs">Quitar</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex gap-2">
        <button onClick={addRange} className="px-3 py-1.5 bg-slate-200 rounded-lg text-xs">+ Rango</button>
        <button onClick={save} className="px-4 py-2 bg-emerald-600 text-white rounded-xl">{editing ? 'Actualizar tabla' : 'Guardar tabla'}</button>
        {editing && <button onClick={() => { setEditing(null); setRanges([{ ...EMPTY_RANGE }]); }} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>}
      </div>

      <h3 className="font-semibold text-slate-700 text-sm pt-2">Tablas registradas</h3>
      <table className="tbl text-sm">
        <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Año</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-center">Rangos</th><th className="px-3 py-2 text-center">Activa</th><th></th></tr></thead>
        <tbody>
          {tables.map((t) => (
            <tr key={t._id} className="border-t">
              <td className="px-3 py-2 font-mono">{t.year}</td>
              <td className="px-3 py-2 text-xs">{t.periodType}</td>
              <td className="px-3 py-2 text-center">{t.ranges?.length || 0}</td>
              <td className="px-3 py-2 text-center">{t.active ? <span className="text-emerald-600">✓</span> : '—'}</td>
              <td className="px-3 py-2 text-right flex gap-2 justify-end">
                <button onClick={() => edit(t)} className="text-blue-600 text-xs">Editar</button>
                <button onClick={() => toggle(t)} className="text-slate-600 text-xs">{t.active ? 'Desactivar' : 'Activar'}</button>
              </td>
            </tr>
          ))}
          {tables.length === 0 && <tr><td colSpan={5} className="px-3 py-4 text-center text-slate-400">Sin tablas. Usa «Sembrar tabla SRI 2024».</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
