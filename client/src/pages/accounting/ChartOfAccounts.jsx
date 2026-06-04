import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineBookOpen, HiOutlineSparkles } from 'react-icons/hi2';

const EMPTY = { code: '', name: '', type: 'ACTIVO', nature: 'DEBITO', parent: null, level: 1, allowsMovement: true, taxCode: '', active: true };

export default function ChartOfAccounts() {
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [q, setQ] = useState('');
  const [filterType, setFilterType] = useState('');

  const load = async () => {
    setLoading(true);
    try {
      const params = {};
      if (q) params.q = q;
      if (filterType) params.type = filterType;
      const r = await api.get('/chart-of-accounts', { params });
      setList(r.data || []);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [filterType]);

  const submit = async (e) => {
    e.preventDefault();
    try {
      if (editing) await api.put(`/chart-of-accounts/${editing._id}`, form);
      else await api.post('/chart-of-accounts', form);
      toast.success('Guardado');
      setShow(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  const remove = async (a) => {
    if (!confirm(`¿Eliminar cuenta ${a.code} - ${a.name}?`)) return;
    try { await api.delete(`/chart-of-accounts/${a._id}`); load(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const seed = async () => {
    if (!confirm('Cargar plan de cuentas Supercías por defecto? (no sobrescribe existentes)')) return;
    try {
      const r = await api.post('/chart-of-accounts/seed');
      toast.success(`${r.data.created || 0} cuentas creadas`);
      load();
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineBookOpen className="text-emerald-600" /> Plan de Cuentas</h1>
          <p className="text-sm text-slate-500">Catálogo contable jerárquico bajo norma Supercías.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={seed} className="px-3 py-2 bg-amber-500 text-white rounded-lg flex items-center gap-2 hover:bg-amber-600">
            <HiOutlineSparkles className="w-4 h-4" /> Cargar plan inicial
          </button>
          <button onClick={() => { setEditing(null); setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 hover:bg-emerald-700">
            <HiOutlinePlus className="w-4 h-4" /> Nueva cuenta
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl p-3 shadow-sm border border-emerald-100 flex gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="Buscar por código o nombre" className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" />
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-lg text-sm">
          <option value="">Todos los tipos</option>
          <option>ACTIVO</option><option>PASIVO</option><option>PATRIMONIO</option>
          <option>INGRESO</option><option>GASTO</option><option>COSTO</option><option>ORDEN</option>
        </select>
        <button onClick={load} className="px-4 py-2 bg-slate-700 text-white rounded-lg text-sm">Buscar</button>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-emerald-900 text-xs uppercase">
            <tr>
              <th className="px-3 py-2 text-left">Código</th>
              <th className="px-3 py-2 text-left">Nombre</th>
              <th className="px-3 py-2 text-left">Tipo</th>
              <th className="px-3 py-2 text-left">Naturaleza</th>
              <th className="px-3 py-2 text-center">Movimiento</th>
              <th className="px-3 py-2 text-center">Activa</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={7} className="text-center p-6 text-slate-400">Cargando...</td></tr>
              : list.map((a) => (
                <tr key={a._id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono">{a.code}</td>
                  <td className="px-3 py-2" style={{ paddingLeft: `${(a.level - 1) * 16 + 12}px` }}>{a.name}</td>
                  <td className="px-3 py-2 text-xs">{a.type}</td>
                  <td className="px-3 py-2 text-xs">{a.nature}</td>
                  <td className="px-3 py-2 text-center">{a.allowsMovement ? '✓' : '—'}</td>
                  <td className="px-3 py-2 text-center">{a.active ? '✓' : '—'}</td>
                  <td className="px-3 py-2 flex gap-1 justify-end">
                    <button onClick={() => { setEditing(a); setForm({ ...a, parent: a.parent || null }); setShow(true); }} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                    {!a.isSystem && <button onClick={() => remove(a)} className="p-1.5 text-rose-600 hover:bg-rose-50 rounded"><HiOutlineTrash className="w-4 h-4" /></button>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar cuenta' : 'Nueva cuenta'}>
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div><label className="text-xs text-slate-600">Código *</label><input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2" /></div>
            <div><label className="text-xs text-slate-600">Nivel</label><input type="number" min="1" max="6" value={form.level} onChange={(e) => setForm({ ...form, level: +e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2" /></div>
          </div>
          <div><label className="text-xs text-slate-600">Nombre *</label><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-600">Tipo</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2">
                <option>ACTIVO</option><option>PASIVO</option><option>PATRIMONIO</option>
                <option>INGRESO</option><option>GASTO</option><option>COSTO</option><option>ORDEN</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-600">Naturaleza</label>
              <select value={form.nature} onChange={(e) => setForm({ ...form, nature: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2">
                <option>DEBITO</option><option>CREDITO</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.allowsMovement} onChange={(e) => setForm({ ...form, allowsMovement: e.target.checked })} /> Permite movimiento</label>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Activa</label>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
            <button type="submit" className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
