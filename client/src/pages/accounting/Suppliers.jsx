import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineUserGroup } from 'react-icons/hi2';

const ROLES = ['CLIENTE', 'PROVEEDOR', 'EMPLEADO', 'VENDEDOR'];
const ROLE_LABEL = { CLIENTE: 'Cliente', PROVEEDOR: 'Proveedor', EMPLEADO: 'Empleado', VENDEDOR: 'Vendedor' };
const ROLE_COLOR = { CLIENTE: 'bg-blue-100 text-blue-700', PROVEEDOR: 'bg-amber-100 text-amber-700', EMPLEADO: 'bg-emerald-100 text-emerald-700', VENDEDOR: 'bg-purple-100 text-purple-700' };
const EMPTY = { ruc: '', tipoIdentificacion: 'RUC', razonSocial: '', nombreComercial: '', email: '', phone: '', address: '', roles: ['CLIENTE'], isSpecialContributor: false, isWithholdingAgent: false, rimpe: '', active: true };

export default function Suppliers() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [q, setQ] = useState('');
  const [roleFilter, setRoleFilter] = useState('');

  const load = async () => {
    try { const r = await api.get('/suppliers', { params: { q, role: roleFilter || undefined } }); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [roleFilter]);

  const selectRole = (r) => {
    setForm((f) => ({ ...f, roles: [r] }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (!form.roles.length) return toast.error('Selecciona al menos un rol');
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
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineUserGroup className="text-emerald-600" /> Personas</h1>
        <button onClick={() => { setEditing(null); setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
      </div>
      <div className="bg-white rounded-xl p-3 shadow-sm flex gap-2 flex-wrap items-center">
        <input placeholder="Buscar por RUC o nombre" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} className="flex-1 min-w-[200px] px-3 py-2 border border-slate-200 rounded-lg" />
        <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-lg">
          <option value="">Todos los roles</option>
          {ROLES.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
        </select>
        <button onClick={load} className="px-4 py-2 bg-slate-700 text-white rounded-lg">Buscar</button>
      </div>
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">RUC/CI</th><th className="px-3 py-2 text-left">Nombre</th>
            <th className="px-3 py-2 text-left">Roles</th><th className="px-3 py-2 text-left">Contacto</th>
            <th className="px-3 py-2 text-center">RIMPE</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2 font-mono text-xs">{s.ruc}</td>
                <td className="px-3 py-2">{s.razonSocial}{s.nombreComercial ? <span className="text-slate-400 text-xs block">{s.nombreComercial}</span> : null}</td>
                <td className="px-3 py-2"><div className="flex gap-1 flex-wrap">{(s.roles || []).map((r) => <span key={r} className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${ROLE_COLOR[r] || 'bg-slate-100'}`}>{ROLE_LABEL[r] || r}</span>)}</div></td>
                <td className="px-3 py-2 text-xs">{s.email}<br />{s.phone}</td>
                <td className="px-3 py-2 text-center text-xs">{s.rimpe}</td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => { setEditing(s); setForm({ ...EMPTY, ...s, roles: s.roles?.length ? s.roles : ['PROVEEDOR'] }); setShow(true); }} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                  <button onClick={() => remove(s)} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Sin registros</td></tr>}
          </tbody>
        </table>
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar persona' : 'Nueva persona'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div>
            <p className="text-xs font-semibold text-slate-500 mb-1">Roles</p>
            <div className="flex gap-3 flex-wrap">
              {ROLES.map((r) => (
                <label key={r} className={`px-3 py-1.5 rounded-lg text-sm cursor-pointer border ${form.roles[0] === r ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white border-slate-200'}`}>
                  <input type="radio" name="persona-rol" className="hidden" checked={form.roles[0] === r} onChange={() => selectRole(r)} />{ROLE_LABEL[r]}
                </label>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <select value={form.tipoIdentificacion} onChange={(e) => setForm({ ...form, tipoIdentificacion: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>RUC</option><option>CEDULA</option><option>PASAPORTE</option></select>
            <input required placeholder="RUC/CI" value={form.ruc} onChange={(e) => setForm({ ...form, ruc: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input required placeholder="Razón social / Nombre" value={form.razonSocial} onChange={(e) => setForm({ ...form, razonSocial: e.target.value })} className="col-span-2 border border-slate-200 rounded-lg px-3 py-2" />
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
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
