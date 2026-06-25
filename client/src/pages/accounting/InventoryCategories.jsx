import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineSquares2X2, HiOutlinePencilSquare, HiOutlineTrash } from 'react-icons/hi2';
import NumericInput from '../../components/NumericInput';
import SearchableSelect from '../../components/SearchableSelect';

const EMPTY = { code: '', name: '', kind: 'INVENTARIO', parent: '', depreciationRate: 0, usefulLifeYears: 0, residualPercent: 0, noDepreciate: false, expenseType: '', assetAccount: '', depreciationAccount: '', accumDepreciationAccount: '', impairmentAssetAccount: '', impairmentExpenseAccount: '', expenseAccount: '', incomeAccount: '' };
// Sugerencias para el "Tipo" (clasificación contable). El campo es de texto libre:
// el usuario puede elegir una sugerencia o escribir cualquier otra.
const EXPENSE_TYPES = ['Gastos Ventas', 'Gastos Administrativos', 'Costo de Ventas', 'Gastos Financieros', 'Gastos No Deducibles'];

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
    load();
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement))).catch(() => {});
  }, []);

  const idOf = (v) => (v && typeof v === 'object' ? v._id : v) || '';

  const submit = async (e) => {
    e.preventDefault();
    const payload = { ...form };
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
    setForm({ ...EMPTY, ...c, parent: idOf(c.parent), assetAccount: idOf(c.assetAccount), depreciationAccount: idOf(c.depreciationAccount), accumDepreciationAccount: idOf(c.accumDepreciationAccount), impairmentAssetAccount: idOf(c.impairmentAssetAccount), impairmentExpenseAccount: idOf(c.impairmentExpenseAccount), expenseAccount: idOf(c.expenseAccount), incomeAccount: idOf(c.incomeAccount) });
    setShow(true);
  };

  const parentOptions = list.filter((c) => c.kind === form.kind && !c.parent && c._id !== editing?._id);
  const nameById = (id) => list.find((c) => c._id === id)?.name || '';
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
                <td className="px-3 py-2">{c.parent ? '↳ ' : ''}{c.name}</td>
                <td className="px-3 py-2 text-xs">{c.kind}</td>
                <td className="px-3 py-2 text-xs text-slate-500">{c.parent ? nameById(idOf(c.parent)) : '—'}</td>
                <td className="px-3 py-2 text-right">{c.depreciationRate || '—'}%</td>
                <td className="px-3 py-2 text-right">{c.usefulLifeYears || '—'} años</td>
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
            {form.kind === 'ACTIVO_FIJO' && <>
              <Field label="Tipo">
                <input list="cat-expense-types" value={form.expenseType} onChange={(e) => setForm({ ...form, expenseType: e.target.value })} placeholder="Gastos Ventas… o escribe otro" className={inputCls} />
                <datalist id="cat-expense-types">
                  {EXPENSE_TYPES.map((t) => <option key={t} value={t} />)}
                </datalist>
              </Field>
              <Field label="% Depreciación anual"><NumericInput step="0.01" value={form.depreciationRate} disabled={form.noDepreciate} onChange={(e) => setForm({ ...form, depreciationRate: +e.target.value })} className={inputCls} /></Field>
              <Field label="Vida útil (años)"><NumericInput value={form.usefulLifeYears} disabled={form.noDepreciate} onChange={(e) => setForm({ ...form, usefulLifeYears: +e.target.value })} className={inputCls} /></Field>
              <Field label="% Valor residual"><NumericInput step="0.01" value={form.residualPercent} onChange={(e) => setForm({ ...form, residualPercent: +e.target.value })} className={inputCls} /></Field>
              <label className="col-span-2 flex items-center gap-2 text-sm text-slate-600">
                <input type="checkbox" checked={!!form.noDepreciate} onChange={(e) => setForm({ ...form, noDepreciate: e.target.checked })} />
                No Depreciar (aplica para terrenos)
              </label>
            </>}
          </div>
          <p className="text-xs font-semibold text-slate-500 pt-1">Cuentas contables vinculadas</p>
          <div className="grid grid-cols-2 gap-3">
            {form.kind === 'ACTIVO_FIJO' ? (
              <>
                {acctField('Cuenta de activo', 'assetAccount')}
                {acctField('Gasto depreciación', 'depreciationAccount')}
                {acctField('Depreciación acumulada', 'accumDepreciationAccount', 'col-span-2')}
                {acctField('Cta. Activo Deterioro', 'impairmentAssetAccount')}
                {acctField('Cta. Gasto Deterioro', 'impairmentExpenseAccount')}
              </>
            ) : (
              <>
                {acctField('Cuenta de inventario', 'assetAccount')}
                {acctField('Costo / gasto', 'expenseAccount')}
                {acctField('Ingreso por venta', 'incomeAccount', 'col-span-2')}
              </>
            )}
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
