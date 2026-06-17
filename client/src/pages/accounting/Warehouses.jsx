import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlinePlus, HiOutlineCube, HiOutlinePencilSquare, HiOutlineTrash } from 'react-icons/hi2';

export default function Warehouses() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({ code: '', name: '', address: '', isMain: false, active: true });

  const load = async () => {
    try { const r = await api.get('/inventory-advanced/warehouses'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/inventory-advanced/warehouses/${editing._id}`, form);
      else await api.post('/inventory-advanced/warehouses', form);
      toast.success('Guardado'); setShow(false); setEditing(null); setForm({ code: '', name: '', address: '', isMain: false, active: true }); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const remove = async (w) => { if (!confirm('¿Eliminar?')) return; try { await api.delete(`/inventory-advanced/warehouses/${w._id}`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCube className="text-emerald-600" /> Bodegas</h1>
        <button onClick={() => { setEditing(null); setForm({ code: '', name: '', address: '', isMain: false, active: true }); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Nombre</th><th className="px-3 py-2 text-left">Dirección</th><th className="px-3 py-2 text-center">Principal</th><th></th></tr></thead>
          <tbody>
            {list.map((w) => (
              <tr key={w._id} className="border-t">
                <td className="px-3 py-2 font-mono">{w.code}</td>
                <td className="px-3 py-2">{w.name}</td>
                <td className="px-3 py-2 text-slate-500">{w.address}</td>
                <td className="px-3 py-2 text-center">{w.isMain ? '✓' : '—'}</td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => { setEditing(w); setForm(w); setShow(true); }} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                  <button onClick={() => remove(w)} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar bodega' : 'Nueva bodega'}>
        <form onSubmit={submit} className="space-y-3">
          <Field label="Código" required><input required placeholder="Ej: BOD-01" value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <Field label="Nombre" required><input required placeholder="Ej: Bodega principal" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <Field label="Dirección"><input placeholder="Dirección física" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></Field>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.isMain} onChange={(e) => setForm({ ...form, isMain: e.target.checked })} /> Principal</label>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
