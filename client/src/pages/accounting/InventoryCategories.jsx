import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineSquares2X2, HiOutlinePencilSquare, HiOutlineTrash } from 'react-icons/hi2';

const EMPTY = { code: '', name: '', kind: 'INVENTARIO', parent: '', depreciationRate: 0, usefulLifeYears: 0, residualPercent: 0, assetAccount: '', depreciationAccount: '', accumDepreciationAccount: '', expenseAccount: '', incomeAccount: '' };

export default function InventoryCategories() {
  const [list, setList] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

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
    ['parent', 'assetAccount', 'depreciationAccount', 'accumDepreciationAccount', 'expenseAccount', 'incomeAccount'].forEach((k) => { if (!payload[k]) payload[k] = null; });
    try {
      if (editing) await api.put(`/inventory-advanced/categories/${editing._id}`, payload);
      else await api.post('/inventory-advanced/categories', payload);
      toast.success('Guardado'); setShow(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const remove = async (c) => { if (!confirm('¿Eliminar?')) return; try { await api.delete(`/inventory-advanced/categories/${c._id}`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };

  const openEdit = (c) => {
    setEditing(c);
    setForm({ ...EMPTY, ...c, parent: idOf(c.parent), assetAccount: idOf(c.assetAccount), depreciationAccount: idOf(c.depreciationAccount), accumDepreciationAccount: idOf(c.accumDepreciationAccount), expenseAccount: idOf(c.expenseAccount), incomeAccount: idOf(c.incomeAccount) });
    setShow(true);
  };

  const parentOptions = list.filter((c) => c.kind === form.kind && !c.parent && c._id !== editing?._id);
  const nameById = (id) => list.find((c) => c._id === id)?.name || '';
  const inputCls = 'border border-slate-200 rounded-lg px-3 py-2';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineSquares2X2 className="text-emerald-600" /> Categorías Inventario/Activos</h1>
        <button onClick={() => { setEditing(null); setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="w-full text-sm">
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
            <input required placeholder="Código" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className={inputCls} />
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value, parent: '' })} className={inputCls}><option>INVENTARIO</option><option>ACTIVO_FIJO</option></select>
            <input required placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="col-span-2 border border-slate-200 rounded-lg px-3 py-2" />
            <select value={form.parent} onChange={(e) => setForm({ ...form, parent: e.target.value })} className={`${inputCls} col-span-2`}>
              <option value="">Categoría raíz (sin padre)</option>
              {parentOptions.map((c) => <option key={c._id} value={c._id}>{c.code} - {c.name}</option>)}
            </select>
            {form.kind === 'ACTIVO_FIJO' && <>
              <input type="number" step="0.01" placeholder="% Dep. anual" value={form.depreciationRate} onChange={(e) => setForm({ ...form, depreciationRate: +e.target.value })} className={inputCls} />
              <input type="number" placeholder="Vida útil años" value={form.usefulLifeYears} onChange={(e) => setForm({ ...form, usefulLifeYears: +e.target.value })} className={inputCls} />
              <input type="number" step="0.01" placeholder="% Residual" value={form.residualPercent} onChange={(e) => setForm({ ...form, residualPercent: +e.target.value })} className={`${inputCls} col-span-2`} />
            </>}
          </div>
          <p className="text-xs font-semibold text-slate-500 pt-1">Cuentas contables vinculadas</p>
          <div className="grid grid-cols-2 gap-3">
            {form.kind === 'ACTIVO_FIJO' ? (
              <>
                <select value={form.assetAccount} onChange={(e) => setForm({ ...form, assetAccount: e.target.value })} className={inputCls}><option value="">Cuenta de activo...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}</select>
                <select value={form.depreciationAccount} onChange={(e) => setForm({ ...form, depreciationAccount: e.target.value })} className={inputCls}><option value="">Gasto depreciación...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}</select>
                <select value={form.accumDepreciationAccount} onChange={(e) => setForm({ ...form, accumDepreciationAccount: e.target.value })} className={`${inputCls} col-span-2`}><option value="">Depreciación acumulada...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}</select>
              </>
            ) : (
              <>
                <select value={form.assetAccount} onChange={(e) => setForm({ ...form, assetAccount: e.target.value })} className={inputCls}><option value="">Cuenta de inventario...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}</select>
                <select value={form.expenseAccount} onChange={(e) => setForm({ ...form, expenseAccount: e.target.value })} className={inputCls}><option value="">Costo/gasto...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}</select>
                <select value={form.incomeAccount} onChange={(e) => setForm({ ...form, incomeAccount: e.target.value })} className={`${inputCls} col-span-2`}><option value="">Ingreso por venta...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}</select>
              </>
            )}
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
