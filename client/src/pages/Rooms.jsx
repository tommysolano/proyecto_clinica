import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineBuildingStorefront } from 'react-icons/hi2';

const EMPTY = { name: '', code: '', description: '', manager: '', active: true };

export default function Rooms() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [showModal, setShowModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/rooms');
      setList(r.data || []);
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    api.get('/users').then((r) => setUsers(r.data || []));
    load();
  }, []);

  const openNew = () => { setEditing(null); setForm(EMPTY); setShowModal(true); };
  const openEdit = (r) => {
    setEditing(r);
    setForm({
      name: r.name,
      code: r.code || '',
      description: r.description || '',
      manager: r.manager?._id || '',
      active: r.active,
    });
    setShowModal(true);
  };

  const submit = async (e) => {
    e.preventDefault();
    try {
      const body = { ...form, manager: form.manager || null };
      if (editing) await api.put(`/rooms/${editing._id}`, body);
      else await api.post('/rooms', body);
      toast.success('Guardado');
      setShowModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  const remove = async (r) => {
    if (!confirm(`¿Desactivar "${r.name}"?`)) return;
    try {
      await api.delete(`/rooms/${r._id}`);
      load();
    } catch (err) {
      toast.error(err.response?.data?.message || 'Error');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <HiOutlineBuildingStorefront className="text-emerald-600" /> Consultorios físicos
          </h1>
          <p className="text-sm text-slate-500">
            Salas/consultorios donde se atienden citas. Cada consultorio puede tener un encargado.
          </p>
        </div>
        <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2 hover:bg-emerald-700">
          <HiOutlinePlus className="w-4 h-4" /> Nuevo consultorio
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-left px-3 py-2">Nombre</th>
              <th className="text-left px-3 py-2">Código</th>
              <th className="text-left px-3 py-2">Encargado</th>
              <th className="text-left px-3 py-2">Descripción</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan={5} className="text-center py-4 text-slate-400">Cargando...</td></tr>}
            {list.map((r) => (
              <tr key={r._id} className="border-t border-slate-100">
                <td className="px-3 py-2 font-medium">{r.name}</td>
                <td className="px-3 py-2">{r.code || '—'}</td>
                <td className="px-3 py-2">{r.manager?.name || '—'}</td>
                <td className="px-3 py-2 text-slate-500">{r.description || ''}</td>
                <td className="px-3 py-2 flex gap-1">
                  <button onClick={() => openEdit(r)} className="p-1 text-sky-600 hover:bg-sky-50 rounded"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                  <button onClick={() => remove(r)} className="p-1 text-rose-600 hover:bg-rose-50 rounded"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
            {!loading && list.length === 0 && <tr><td colSpan={5} className="text-center py-6 text-slate-400">Sin consultorios</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={showModal} onClose={() => setShowModal(false)} title={editing ? 'Editar consultorio' : 'Nuevo consultorio'}>
        <form onSubmit={submit} className="space-y-3">
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Nombre</span>
            <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Código</span>
            <input value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Encargado</span>
            <select value={form.manager} onChange={(e) => setForm({ ...form, manager: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm">
              <option value="">— Sin encargado —</option>
              {users.map((u) => <option key={u._id} value={u._id}>{u.name}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-medium text-slate-600">Descripción</span>
            <textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
          </label>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShowModal(false)} className="px-4 py-2 rounded-lg border border-slate-200">Cancelar</button>
            <button type="submit" className="px-4 py-2 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700">Guardar</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
