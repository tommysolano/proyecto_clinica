import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineSquares2X2, HiOutlinePencilSquare, HiOutlineTrash } from 'react-icons/hi2';

const EMPTY = { code: '', name: '', kind: 'INVENTARIO', depreciationRate: 0, usefulLifeYears: 0, residualPercent: 0 };

export default function InventoryCategories() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    try { const r = await api.get('/inventory-advanced/categories'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/inventory-advanced/categories/${editing._id}`, form);
      else await api.post('/inventory-advanced/categories', form);
      toast.success('Guardado'); setShow(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const remove = async (c) => { if (!confirm('¿Eliminar?')) return; try { await api.delete(`/inventory-advanced/categories/${c._id}`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineSquares2X2 className="text-emerald-600" /> Categorías Inventario/Activos</h1>
        <button onClick={() => { setEditing(null); setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
      </div>
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Cód.</th><th className="px-3 py-2 text-left">Nombre</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-right">% Dep.</th><th className="px-3 py-2 text-right">Vida útil</th><th></th></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c._id} className="border-t">
                <td className="px-3 py-2 font-mono">{c.code}</td>
                <td className="px-3 py-2">{c.name}</td>
                <td className="px-3 py-2 text-xs">{c.kind}</td>
                <td className="px-3 py-2 text-right">{c.depreciationRate || '—'}%</td>
                <td className="px-3 py-2 text-right">{c.usefulLifeYears || '—'} años</td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => { setEditing(c); setForm(c); setShow(true); }} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                  <button onClick={() => remove(c)} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar categoría' : 'Nueva categoría'}>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input required placeholder="Código" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>INVENTARIO</option><option>ACTIVO_FIJO</option></select>
            <input required placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="col-span-2 border border-slate-200 rounded-lg px-3 py-2" />
            {form.kind === 'ACTIVO_FIJO' && <>
              <input type="number" step="0.01" placeholder="% Dep. anual" value={form.depreciationRate} onChange={(e) => setForm({ ...form, depreciationRate: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
              <input type="number" placeholder="Vida útil años" value={form.usefulLifeYears} onChange={(e) => setForm({ ...form, usefulLifeYears: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
              <input type="number" step="0.01" placeholder="% Residual" value={form.residualPercent} onChange={(e) => setForm({ ...form, residualPercent: +e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            </>}
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
