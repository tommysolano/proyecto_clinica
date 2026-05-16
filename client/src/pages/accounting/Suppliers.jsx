import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineTruck } from 'react-icons/hi2';

const EMPTY = { ruc: '', tipoIdentificacion: 'RUC', razonSocial: '', nombreComercial: '', email: '', phone: '', address: '', isSpecialContributor: false, isWithholdingAgent: false, rimpe: '', active: true };

export default function Suppliers() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [q, setQ] = useState('');

  const load = async () => {
    try { const r = await api.get('/suppliers', { params: { q } }); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, []);

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/suppliers/${editing._id}`, form);
      else await api.post('/suppliers', form);
      toast.success('Guardado'); setShow(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const remove = async (s) => {
    if (!confirm('¿Eliminar?')) return;
    try { await api.delete(`/suppliers/${s._id}`); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineTruck className="text-emerald-600" /> Proveedores</h1>
        <button onClick={() => { setEditing(null); setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2"><HiOutlinePlus /> Nuevo</button>
      </div>
      <div className="bg-white rounded-xl p-3 shadow-sm flex gap-2">
        <input placeholder="Buscar por RUC o razón social" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} className="flex-1 px-3 py-2 border border-slate-200 rounded-lg" />
        <button onClick={load} className="px-4 py-2 bg-slate-700 text-white rounded-lg">Buscar</button>
      </div>
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">RUC/CI</th><th className="px-3 py-2 text-left">Razón Social</th>
            <th className="px-3 py-2 text-left">Comercial</th><th className="px-3 py-2 text-left">Contacto</th>
            <th className="px-3 py-2 text-center">RIMPE</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs">{s.ruc}</td>
                <td className="px-3 py-2">{s.razonSocial}</td>
                <td className="px-3 py-2 text-slate-500">{s.nombreComercial}</td>
                <td className="px-3 py-2 text-xs">{s.email}<br />{s.phone}</td>
                <td className="px-3 py-2 text-center text-xs">{s.rimpe}</td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => { setEditing(s); setForm(s); setShow(true); }} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                  <button onClick={() => remove(s)} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar proveedor' : 'Nuevo proveedor'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <select value={form.tipoIdentificacion} onChange={(e) => setForm({ ...form, tipoIdentificacion: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>RUC</option><option>CEDULA</option><option>PASAPORTE</option></select>
            <input required placeholder="RUC/CI" value={form.ruc} onChange={(e) => setForm({ ...form, ruc: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input required placeholder="Razón social" value={form.razonSocial} onChange={(e) => setForm({ ...form, razonSocial: e.target.value })} className="col-span-2 border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Nombre comercial" value={form.nombreComercial} onChange={(e) => setForm({ ...form, nombreComercial: e.target.value })} className="col-span-2 border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Teléfono" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Dirección" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} className="col-span-2 border border-slate-200 rounded-lg px-3 py-2" />
            <select value={form.rimpe} onChange={(e) => setForm({ ...form, rimpe: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option value="">Régimen General</option><option value="POPULAR">RIMPE Popular</option><option value="EMPRENDEDOR">RIMPE Emprendedor</option></select>
            <div className="flex gap-3 items-center">
              <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={form.isSpecialContributor} onChange={(e) => setForm({ ...form, isSpecialContributor: e.target.checked })} /> Especial</label>
              <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={form.isWithholdingAgent} onChange={(e) => setForm({ ...form, isWithholdingAgent: e.target.checked })} /> Ag. retención</label>
            </div>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
