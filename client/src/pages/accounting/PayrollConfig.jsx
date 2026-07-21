import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCog6Tooth, HiOutlinePlus, HiOutlineDocumentDuplicate } from 'react-icons/hi2';
import NumericInput from '../../components/NumericInput';
import SharedAccountSelect from '../../components/AccountSelect';

const inputCls = 'border border-slate-200 rounded-xl px-3.5 py-2.5 w-full';
const TABS = [['params', 'Parámetros'], ['accounts', 'Cuentas Contables'], ['positions', 'Cargos'], ['incometax', 'Impuesto Renta']];

// Tipos de cuenta admitidos por letra (A Activo, P Pasivo, G Costos/Gastos, I Ingresos).
const TYPE_MAP = { A: ['ACTIVO'], P: ['PASIVO'], G: ['GASTO', 'COSTO'], I: ['INGRESO'] };
const typesFor = (letters) => letters.flatMap((l) => TYPE_MAP[l] || []);
const filterFor = (letters) => { const t = typesFor(letters); return (a) => t.includes(a.type); };

const DEPARTMENTS = [['ADMINISTRATIVO', 'Administrativo'], ['VENTAS', 'Ventas'], ['COSTOS', 'Costos'], ['OTROS', 'Otros']];

// Campos de GASTO por departamento (cambian al elegir departamento arriba).
const DEPT_INCOME = [
  ['sueldo', 'Sueldo', ['G']],
  ['alimentacion', 'Alimentación', ['G']],
  ['transporte', 'Transporte', ['G']],
  ['vivienda', 'Vivienda', ['G']],
  ['comisiones', 'Comisiones', ['G']],
  ['horasExtra', 'Horas Extra', ['G']],
  ['bonificaciones', 'Bonificaciones', ['G']],
  ['otrosIngresos', 'Otros', ['G', 'P', 'A']],
  ['devBeneficios', 'Dev. Beneficios Sociales', ['G', 'P', 'A']],
  ['devDiasMultas', 'Dev. Días laborados/multas', ['G', 'P', 'A']],
];
const DEPT_EXPENSE = [
  ['dec3Gasto', 'Décimo Tercero — Gasto', ['G']],
  ['dec4Gasto', 'Décimo Cuarto — Gasto', ['G']],
  ['fondosReservaGasto', 'Fondos de Reserva — Gasto', ['G']],
  ['vacacionesGasto', 'Vacaciones — Gasto', ['G']],
  ['aportePatronalGasto', 'Aporte Patronal — Gasto', ['G']],
  ['secapGasto', 'SECAP/IECE — Gasto', ['G']],
];

// Campos GLOBALES de balance (no cambian por departamento).
const GLOBAL_DISCOUNTS = [
  ['anticipos', 'Anticipos a Empleado', ['A']],
  ['descuento', 'Descuento', ['A', 'P']],
  ['multa', 'Multa', ['A', 'P', 'I']],
  ['ausencias', 'Ausencias', ['A', 'P']],
  ['comisariato', 'Comisariato', ['A', 'P']],
  ['farmacia', 'Farmacia', ['A', 'P']],
  ['seguros', 'Seguros', ['A', 'P']],
  ['celular', 'Celular', ['A', 'P']],
  ['descuentoDiasNoLaborados', 'Descuento días/horas no laborados', ['A', 'P']],
];
const GLOBAL_OTHER = [
  ['prestamoQuirografario', 'Préstamo Quirografario', ['P']],
  ['prestamoHipotecario', 'Préstamo Hipotecario', ['P']],
  ['prestamoPersonal', 'Préstamo Personal', ['A']],
  ['otrosEgresos', 'Otros', ['A', 'P']],
  ['impRenta', 'Imp. Renta', ['P']],
];
const GLOBAL_EMPLOYEE = [
  ['sueldosPorPagar', 'Sueldos x pagar', ['P']],
  ['dec3Pasivo', 'Décimo Tercero — Pasivo', ['P']],
  ['dec4Pasivo', 'Décimo Cuarto — Pasivo', ['P']],
  ['fondosReservaPasivo', 'Fondos de Reserva — Pasivo', ['P']],
  ['vacacionesPasivo', 'Vacaciones — Pasivo', ['P']],
];
const GLOBAL_IESS = [
  ['iessPersonal', '9.45% Aporte Personal IESS', ['P']],
  ['aporteConyugal', '3.41% Aporte Conyugal IESS', ['P']],
  ['aportePatronalPasivo', 'Aporte Patronal — Pasivo', ['P']],
  ['secapPasivo', 'SECAP/IECE — Pasivo', ['P']],
];

export default function PayrollConfig() {
  const [tab, setTab] = useState('params');
  const [cfg, setCfg] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [positions, setPositions] = useState([]);
  const [depts, setDepts] = useState([]);
  const [irTables, setIrTables] = useState([]);

  const loadCfg = () => api.get('/payroll/config').then((r) => setCfg(r.data)).catch((e) => toast.error(e.response?.data?.message || 'Error'));
  const loadPositions = () => api.get('/payroll/positions').then((r) => setPositions(r.data || [])).catch(() => {});
  const loadDepts = () => api.get('/payroll/departments').then((r) => setDepts(r.data || [])).catch(() => {});
  const loadIrTables = () => api.get('/payroll/income-tax').then((r) => setIrTables(r.data || [])).catch(() => {});
  useEffect(() => {
    loadCfg(); loadPositions(); loadDepts(); loadIrTables();
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
            <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">% Anticipo de quincena (del sueldo)</span><NumericInput step="0.01" value={cfg.anticipoQuincenaPct ?? 40} onChange={num('anticipoQuincenaPct')} className={inputCls} /></label>
          </div>
          <p className="text-[11px] text-slate-500">El anticipo de la 1ª quincena es este % del sueldo (sin IESS). Sobreescribible por empleado en su ficha.</p>
          <button onClick={saveCfg} className="px-5 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button>
        </div>
      )}

      {tab === 'accounts' && <AccountsTab cfg={cfg} setCfg={setCfg} accounts={accounts} saveCfg={saveCfg} reload={loadCfg} />}
      {tab === 'positions' && <Positions depts={depts} positions={positions} reload={loadPositions} />}
      {tab === 'incometax' && <IncomeTax tables={irTables} reload={loadIrTables} />}
    </div>
  );
}

// Etiqueta con las letras de tipo de cuenta admitidas (A/P/G/I).
function TypeBadges({ letters }) {
  return (
    <span className="flex gap-1">
      {letters.map((l) => <span key={l} className="inline-flex w-4 h-4 items-center justify-center rounded border border-slate-300 text-[9px] font-bold text-slate-500">{l}</span>)}
    </span>
  );
}

function AccountField({ label, letters, value, onChange, accounts }) {
  return (
    <label className="text-xs flex flex-col gap-1">
      <span className="flex items-center gap-1.5 text-slate-600">{label} <TypeBadges letters={letters} /></span>
      <SharedAccountSelect accounts={accounts} value={value || ''} onChange={onChange} filter={filterFor(letters)} emptyOption="Sin cuenta" />
    </label>
  );
}

// ---- Pestaña de Cuentas Contables (estructura Contífico) ----
function AccountsTab({ cfg, setCfg, accounts, saveCfg, reload }) {
  const [dept, setDept] = useState('ADMINISTRATIVO');
  const [copyTo, setCopyTo] = useState('VENTAS');

  const deptVal = (field) => cfg.accounts?.byDepartment?.[dept]?.[field] || '';
  const setDeptVal = (field, v) => setCfg({
    ...cfg,
    accounts: {
      ...cfg.accounts,
      byDepartment: {
        ...cfg.accounts?.byDepartment,
        [dept]: { ...cfg.accounts?.byDepartment?.[dept], [field]: v },
      },
    },
  });
  const globalVal = (field) => cfg.accounts?.global?.[field] || '';
  const setGlobalVal = (field, v) => setCfg({
    ...cfg,
    accounts: { ...cfg.accounts, global: { ...cfg.accounts?.global, [field]: v } },
  });

  const copyAccounts = async () => {
    if (dept === copyTo) return;
    try {
      await api.put('/payroll/config', cfg); // guarda lo actual antes de copiar
      const r = await api.post('/payroll/config/copy-department', { from: dept, to: copyTo });
      setCfg(r.data);
      toast.success(`Cuentas de gasto copiadas a ${DEPARTMENTS.find(([k]) => k === copyTo)?.[1]}`);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      {/* Selector de departamento */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
        <div className="flex gap-2 flex-wrap items-center">
          {DEPARTMENTS.map(([k, l]) => (
            <button key={k} onClick={() => setDept(k)} className={`px-3 py-1.5 rounded-lg text-xs ${dept === k ? 'bg-emerald-600 text-white' : 'bg-slate-100 text-slate-600'}`}>{l}</button>
          ))}
        </div>
        <p className="text-[11px] text-slate-500">
          Revisa las cuentas predeterminadas del sistema; modifícalas si es necesario. Junto a cada campo se indican los tipos de cuenta admitidos: <b>A</b> Activo, <b>P</b> Pasivo, <b>G</b> Costos y Gastos, <b>I</b> Ingresos. Las cuentas de <b>gasto</b> son por departamento; las de <b>balance</b> son generales (más abajo).
        </p>
        <div className="flex items-end gap-2 flex-wrap">
          <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Copiar cuentas de gasto a</span>
            <select value={copyTo} onChange={(e) => setCopyTo(e.target.value)} className="border border-slate-200 rounded-xl px-3 py-2">
              {DEPARTMENTS.filter(([k]) => k !== dept).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </label>
          <button onClick={copyAccounts} className="px-3 py-2 bg-slate-200 rounded-xl text-xs flex items-center gap-1"><HiOutlineDocumentDuplicate /> Copiar cuentas de {DEPARTMENTS.find(([k]) => k === dept)?.[1]}</button>
        </div>
      </div>

      {/* Ingresos del empleado (por departamento) */}
      <Section title={`Ingresos del Empleado — ${DEPARTMENTS.find(([k]) => k === dept)?.[1]}`} subtitle="Cuentas de gasto correspondientes a los rubros que recibe el empleado.">
        <div className="grid grid-cols-2 gap-3">
          {DEPT_INCOME.map(([f, l, t]) => <AccountField key={f} label={l} letters={t} value={deptVal(f)} onChange={(v) => setDeptVal(f, v)} accounts={accounts} />)}
        </div>
      </Section>

      {/* Gastos de provisiones e IESS (por departamento) */}
      <Section title={`Provisiones y aportes — Gasto (${DEPARTMENTS.find(([k]) => k === dept)?.[1]})`} subtitle="Cuentas de gasto de décimos, fondos de reserva, vacaciones y aportes patronales de este departamento (el pasivo es general).">
        <div className="grid grid-cols-2 gap-3">
          {DEPT_EXPENSE.map(([f, l, t]) => <AccountField key={f} label={l} letters={t} value={deptVal(f)} onChange={(v) => setDeptVal(f, v)} accounts={accounts} />)}
        </div>
      </Section>

      <div className="bg-emerald-50/60 border border-emerald-200 rounded-xl px-4 py-2 text-xs text-emerald-800 font-semibold">
        Cuentas generales — aplican a todos los departamentos (no cambian con el selector de arriba)
      </div>

      <Section title="Egresos/Descuentos al Empleado" subtitle="Cuentas de activo/pasivo de los rubros descontados al empleado.">
        <div className="grid grid-cols-2 gap-3">
          {GLOBAL_DISCOUNTS.map(([f, l, t]) => <AccountField key={f} label={l} letters={t} value={globalVal(f)} onChange={(v) => setGlobalVal(f, v)} accounts={accounts} />)}
        </div>
      </Section>
      <Section title="Otros Egresos" subtitle="Préstamos y otros rubros descontados al empleado.">
        <div className="grid grid-cols-2 gap-3">
          {GLOBAL_OTHER.map(([f, l, t]) => <AccountField key={f} label={l} letters={t} value={globalVal(f)} onChange={(v) => setGlobalVal(f, v)} accounts={accounts} />)}
        </div>
      </Section>
      <Section title="Obligaciones con el Empleado" subtitle="Pasivos de las obligaciones sociales con el empleado.">
        <div className="grid grid-cols-2 gap-3">
          {GLOBAL_EMPLOYEE.map(([f, l, t]) => <AccountField key={f} label={l} letters={t} value={globalVal(f)} onChange={(v) => setGlobalVal(f, v)} accounts={accounts} />)}
        </div>
      </Section>
      <Section title="Obligaciones con el IESS" subtitle="Pasivos de los aportes del empleador con el IESS.">
        <div className="grid grid-cols-2 gap-3">
          {GLOBAL_IESS.map(([f, l, t]) => <AccountField key={f} label={l} letters={t} value={globalVal(f)} onChange={(v) => setGlobalVal(f, v)} accounts={accounts} />)}
        </div>
      </Section>

      <button onClick={saveCfg} className="px-5 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar cuentas</button>
    </div>
  );
}

function Section({ title, subtitle, children }) {
  return (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
      <div className="bg-emerald-600 text-white px-4 py-2.5 font-semibold text-sm">{title}</div>
      <div className="p-4 space-y-3">
        {subtitle && <p className="text-[11px] text-slate-500">{subtitle}</p>}
        {children}
      </div>
    </div>
  );
}

// ---- Cargos (contra departamentos estándar) ----
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
      <p className="text-[11px] text-slate-500">Los departamentos (Administrativo, Ventas, Costos, Otros) son fijos: aquí solo creas los CARGOS y los asocias a uno de ellos.</p>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Nombre del cargo</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></label>
        <label className="text-xs flex flex-col gap-1"><span className="text-slate-600">Departamento</span>
          <select value={form.department || ''} onChange={(e) => setForm({ ...form, department: e.target.value })} className={inputCls}><option value="">Seleccione…</option>{depts.map((d) => <option key={d._id} value={d._id}>{d.name}{d.type ? ` (${d.type})` : ''}</option>)}</select>
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
        <button onClick={seed} className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs">Sembrar tabla del año {year}</button>
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
