import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineSquares2X2, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineExclamationTriangle } from 'react-icons/hi2';
import NumericInput from '../../components/NumericInput';
import SearchableSelect from '../../components/SearchableSelect';

const EMPTY = { code: '', name: '', kind: 'INVENTARIO', parent: '', depreciationRate: 0, usefulLifeYears: 0, usefulLifeMonths: 0, residualPercent: 0, noDepreciate: false, expenseType: '', assetAccount: '', depreciationAccount: '', accumDepreciationAccount: '', impairmentAssetAccount: '', impairmentExpenseAccount: '', expenseAccount: '', incomeAccount: '' };
// Tipo de gasto para el estado de resultados (afecta dónde se registra la depreciación).
const EXPENSE_TYPES = ['ADMINISTRATIVO', 'VENTAS', 'COSTOS', 'OTRO'];

export default function InventoryCategories() {
  const [list, setList] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [searchParams] = useSearchParams();
  // Al entrar desde Activos Fijos (?kind=ACTIVO_FIJO) las nuevas categorías nacen como activo fijo.
  const defaultKind = searchParams.get('kind') === 'ACTIVO_FIJO' ? 'ACTIVO_FIJO' : 'INVENTARIO';

  const load = async () => {
    try { const r = await api.get('/inventory-advanced/categories'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- carga inicial: el setState ocurre tras el await (asíncrono, seguro).
    load();
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement))).catch(() => {});
  }, []);

  const idOf = (v) => (v && typeof v === 'object' ? v._id : v) || '';

  const submit = async (e) => {
    e.preventDefault();
    const payload = { ...form };
    // Mantiene usefulLifeYears (legacy) en sincronía con los meses configurados.
    if (payload.kind === 'ACTIVO_FIJO' && payload.usefulLifeMonths) payload.usefulLifeYears = +(payload.usefulLifeMonths / 12).toFixed(2);
    ['parent', 'assetAccount', 'depreciationAccount', 'accumDepreciationAccount', 'impairmentAssetAccount', 'impairmentExpenseAccount', 'expenseAccount', 'incomeAccount'].forEach((k) => { if (!payload[k]) payload[k] = null; });
    try {
      if (editing) await api.put(`/inventory-advanced/categories/${editing._id}`, payload);
      else await api.post('/inventory-advanced/categories', payload);
      toast.success('Guardado'); setShow(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const remove = async (c) => { if (!confirm('¿Eliminar?')) return; try { await api.delete(`/inventory-advanced/categories/${c._id}`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };

  const openEdit = (c) => {
    setEditing(c);
    // Vida útil en meses: usa el campo nuevo o convierte los años legacy.
    const months = c.usefulLifeMonths || (c.usefulLifeYears ? c.usefulLifeYears * 12 : 0);
    setForm({ ...EMPTY, ...c, usefulLifeMonths: months, parent: idOf(c.parent), assetAccount: idOf(c.assetAccount), depreciationAccount: idOf(c.depreciationAccount), accumDepreciationAccount: idOf(c.accumDepreciationAccount), impairmentAssetAccount: idOf(c.impairmentAssetAccount), impairmentExpenseAccount: idOf(c.impairmentExpenseAccount), expenseAccount: idOf(c.expenseAccount), incomeAccount: idOf(c.incomeAccount) });
    setShow(true);
  };

  // Config faltante de una categoría de ACTIVO_FIJO (para alertas).
  const afMissingOf = (c) => {
    if (c.kind !== 'ACTIVO_FIJO') return [];
    const m = [];
    if (!idOf(c.assetAccount)) m.push('cuenta de activo');
    if (!c.noDepreciate) {
      if (!idOf(c.depreciationAccount)) m.push('gasto depreciación');
      if (!idOf(c.accumDepreciationAccount)) m.push('dep. acumulada');
      if (!(c.usefulLifeMonths || c.usefulLifeYears)) m.push('vida útil');
      if (!c.expenseType) m.push('tipo de gasto');
    }
    return m;
  };
  const formAfMissing = (() => {
    if (form.kind !== 'ACTIVO_FIJO') return [];
    const m = [];
    if (!form.assetAccount) m.push('cuenta de activo');
    if (!form.noDepreciate) {
      if (!form.depreciationAccount) m.push('gasto depreciación');
      if (!form.accumDepreciationAccount) m.push('dep. acumulada');
      if (!(form.usefulLifeMonths > 0)) m.push('vida útil (meses)');
      if (!(form.residualPercent >= 0 && form.residualPercent <= 100)) m.push('% residual (0–100)');
      if (!form.expenseType) m.push('tipo de gasto');
    }
    return m;
  })();

  const parentOptions = list.filter((c) => c.kind === form.kind && !c.parent && c._id !== editing?._id);
  const nameById = (id) => list.find((c) => c._id === id)?.name || '';
  // Cuentas que le faltan a una categoría INVENTARIO (para alertas visuales).
  const INV_ACCOUNT_LABELS = { assetAccount: 'inventario', expenseAccount: 'costo/gasto', incomeAccount: 'ingreso' };
  const invMissing = (c) => (c.kind === 'INVENTARIO'
    ? Object.keys(INV_ACCOUNT_LABELS).filter((k) => !idOf(c[k]))
    : []);
  const formInvMissing = form.kind === 'INVENTARIO'
    ? Object.keys(INV_ACCOUNT_LABELS).filter((k) => !form[k])
    : [];
  const inputCls = 'w-full border border-slate-200 rounded-xl px-3.5 py-2.5';

  // Campo de cuenta contable con buscador (reutilizado en todas las cuentas del modal).
  const acctField = (label, key, className = '') => (
    <Field label={label} className={className}>
      <SearchableSelect
        options={accounts}
        value={form[key]}
        onChange={(v) => setForm({ ...form, [key]: v })}
        getLabel={(a) => `${a.code} - ${a.name}`}
        getSearchText={(a) => `${a.code} ${a.name}`}
        placeholder="Seleccione…"
        searchPlaceholder="Buscar por código o nombre…"
        allowClear
      />
    </Field>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineSquares2X2 className="text-emerald-600" /> Categorías Inventario/Activos</h1>
        <button onClick={() => { setEditing(null); setForm({ ...EMPTY, kind: defaultKind }); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Cód.</th><th className="px-3 py-2 text-left">Nombre</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Categoría padre</th><th className="px-3 py-2 text-right">% Dep.</th><th className="px-3 py-2 text-right">Vida útil</th><th></th></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c._id} className="border-t">
                <td className="px-3 py-2 font-mono">{c.code}</td>
                <td className="px-3 py-2">
                  {c.parent ? '↳ ' : ''}{c.name}
                  {invMissing(c).length > 0 && (
                    <span title={`Faltan cuentas: ${invMissing(c).map((k) => INV_ACCOUNT_LABELS[k]).join(', ')}`} className="ml-2 inline-flex items-center gap-1 text-[11px] text-amber-600 align-middle">
                      <HiOutlineExclamationTriangle className="w-3.5 h-3.5" /> sin {invMissing(c).map((k) => INV_ACCOUNT_LABELS[k]).join('/')}
                    </span>
                  )}
                  {afMissingOf(c).length > 0 && (
                    <span title={`Configuración incompleta: falta ${afMissingOf(c).join(', ')}`} className="ml-2 inline-flex items-center gap-1 text-[11px] text-amber-600 align-middle">
                      <HiOutlineExclamationTriangle className="w-3.5 h-3.5" /> incompleta
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-xs">{c.kind}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{c.parent ? nameById(idOf(c.parent)) : '—'}</td>
                <td className="px-3 py-2 text-right">{c.depreciationRate || '—'}%</td>
                <td className="px-3 py-2 text-right">{(c.usefulLifeMonths || (c.usefulLifeYears ? c.usefulLifeYears * 12 : 0)) || '—'} meses</td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => openEdit(c)} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                  <button onClick={() => remove(c)} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar categoría' : 'Nueva categoría'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Código" required><input required placeholder="Ej: INV-01" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} /></Field>
            <Field label="Clase"><select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, parent: '' })} className={inputCls}><option value="INVENTARIO">Inventario</option><option value="ACTIVO_FIJO">Activo fijo</option></select></Field>
            <Field label="Nombre" required className="col-span-2"><input required placeholder="Ej: Medicamentos" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} /></Field>
            <Field label="Categoría padre" hint="Elige una categoría para crear un TIPO (subcategoría) dentro de ella. Déjalo en blanco para una categoría raíz." className="col-span-2">
              <SearchableSelect
                options={parentOptions}
                value={form.parent}
                onChange={(v) => setForm({ ...form, parent: v })}
                getLabel={(c) => `${c.code} - ${c.name}`}
                getSearchText={(c) => `${c.code} ${c.name}`}
                placeholder="Categoría raíz (sin padre)"
                searchPlaceholder="Buscar categoría…"
                allowClear
              />
            </Field>
          </div>
          {form.kind === 'ACTIVO_FIJO' ? (
            <div className="rounded-xl border border-slate-200 p-3 space-y-3">
              <div>
                <p className="text-sm font-semibold text-slate-700">Configuración contable del activo fijo</p>
                <p className="text-[11px] text-slate-400">Estas cuentas y parámetros se copian al activo al comprarlo o crearlo; el usuario no los edita en la factura.</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Tipo de gasto" required={!form.noDepreciate} hint="Clasificación para el estado de resultados.">
                  <select value={form.expenseType} onChange={(e) => setForm({ ...form, expenseType: e.target.value })} className={inputCls}>
                    <option value="">Seleccione…</option>
                    {EXPENSE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    {form.expenseType && !EXPENSE_TYPES.includes(form.expenseType) && <option value={form.expenseType}>{form.expenseType} (legacy)</option>}
                  </select>
                </Field>
                <Field label="Vida útil (meses)" required={!form.noDepreciate}><NumericInput value={form.usefulLifeMonths} disabled={form.noDepreciate} onChange={(e) => setForm({ ...form, usefulLifeMonths: +e.target.value })} className={inputCls} /></Field>
                <Field label="% Valor residual"><NumericInput step="0.01" value={form.residualPercent} disabled={form.noDepreciate} onChange={(e) => setForm({ ...form, residualPercent: +e.target.value })} className={inputCls} /></Field>
                <Field label="% Depreciación anual" hint="Opcional: si lo dejas en 0 se calcula desde la vida útil."><NumericInput step="0.01" value={form.depreciationRate} disabled={form.noDepreciate} onChange={(e) => setForm({ ...form, depreciationRate: +e.target.value })} className={inputCls} /></Field>
                <label className="col-span-2 flex items-center gap-2 text-sm text-slate-600">
                  <input type="checkbox" checked={!!form.noDepreciate} onChange={(e) => setForm({ ...form, noDepreciate: e.target.checked })} />
                  No depreciar (p. ej. terrenos)
                </label>
                {acctField('Cuenta de activo', 'assetAccount')}
                {acctField('Gasto de depreciación', 'depreciationAccount')}
                {acctField('Depreciación acumulada', 'accumDepreciationAccount', 'col-span-2')}
                {acctField('Cta. activo deterioro (opcional)', 'impairmentAssetAccount')}
                {acctField('Cta. gasto deterioro (opcional)', 'impairmentExpenseAccount')}
                {formAfMissing.length > 0 && (
                  <p className="col-span-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 flex items-center gap-1">
                    <HiOutlineExclamationTriangle className="w-3.5 h-3.5 shrink-0" />
                    Configuración incompleta: falta {formAfMissing.join(', ')}. No se podrán comprar ni depreciar activos de esta categoría.
                  </p>
                )}
              </div>
            </div>
          ) : (
            <>
              <p className="text-xs font-semibold text-slate-500 pt-1">Cuentas contables vinculadas</p>
              <div className="grid grid-cols-2 gap-3">
                {acctField('Cuenta de inventario', 'assetAccount')}
                {acctField('Costo / gasto', 'expenseAccount')}
                {acctField('Ingreso por venta', 'incomeAccount', 'col-span-2')}
                {formInvMissing.length > 0 && (
                  <p className="col-span-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1 flex items-center gap-1">
                    <HiOutlineExclamationTriangle className="w-3.5 h-3.5 shrink-0" />
                    Faltan cuentas por configurar: {formInvMissing.map((k) => INV_ACCOUNT_LABELS[k]).join(', ')}. Los productos de esta categoría no tendrán cuentas contables completas.
                  </p>
                )}
              </div>
            </>
          )}
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
