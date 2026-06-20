import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash, HiOutlineBookOpen, HiOutlineSparkles } from 'react-icons/hi2';

const EMPTY = { code: '', name: '', type: 'ACTIVO', nature: 'DEBITO', parent: null, level: 1, allowsMovement: true, taxCode: '', active: true };

export default function ChartOfAccounts() {
  const [list, setList] = useState([]);
  const [allAccounts, setAllAccounts] = useState([]); // catálogo completo para el selector de padre
  const [loading, setLoading] = useState(true);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [parentQuery, setParentQuery] = useState('');
  const [q, setQ] = useState('');
  const [filterType, setFilterType] = useState('');

  const loadAll = async () => {
    try { const r = await api.get('/chart-of-accounts'); setAllAccounts(r.data || []); } catch { /* noop */ }
  };

  // Al elegir una cuenta padre, el backend sugiere código/nivel/tipo/naturaleza.
  const onSelectParent = async (parentId) => {
    if (!parentId) { setForm((f) => ({ ...f, parent: null })); return; }
    try {
      const r = await api.get('/chart-of-accounts/next-code', { params: { parent: parentId } });
      setForm((f) => ({ ...f, parent: parentId, code: r.data.code, level: r.data.level, type: r.data.type, nature: r.data.nature }));
    } catch (e) { toast.error(e.response?.data?.message || 'No se pudo sugerir el código'); }
  };

  const openNew = async () => {
    setEditing(null); setForm(EMPTY); setParentQuery('');
    await loadAll();
    setShow(true);
  };
  const openEdit = async (a) => {
    setEditing(a); setForm({ ...a, parent: a.parent || null }); setParentQuery('');
    await loadAll();
    setShow(true);
  };

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
          <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 hover:bg-emerald-700">
            <HiOutlinePlus className="w-4 h-4" /> Nueva cuenta
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl p-3 shadow-sm border border-emerald-100 flex gap-2">
        <input aria-label="Buscar cuenta" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && load()} placeholder="Buscar por código o nombre" className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm" />
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} className="px-3 py-2 border border-slate-200 rounded-lg text-sm">
          <option value="">Todos los tipos</option>
          <option>ACTIVO</option><option>PASIVO</option><option>PATRIMONIO</option>
          <option>INGRESO</option><option>GASTO</option><option>COSTO</option><option>ORDEN</option>
        </select>
        <button onClick={load} className="px-4 py-2 bg-slate-700 text-white rounded-lg text-sm">Buscar</button>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="tbl">
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
                    <button onClick={() => openEdit(a)} className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                    {!a.isSystem && <button onClick={() => remove(a)} className="p-1.5 text-rose-600 hover:bg-rose-50 rounded"><HiOutlineTrash className="w-4 h-4" /></button>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar cuenta' : 'Nueva cuenta'}>
        <form onSubmit={submit} className="space-y-3">
          {/* Selector de cuenta padre: el código y el nivel se calculan solos. */}
          <div>
            <label className="text-xs text-slate-600">Cuenta padre</label>
            <input
              value={parentQuery}
              onChange={(e) => setParentQuery(e.target.value)}
              placeholder="Buscar la cuenta donde colgar la nueva (código o nombre)…"
              className="w-full border border-slate-200 rounded-xl px-3.5 py-2 mb-1 text-sm"
            />
            <select
              value={form.parent || ''}
              onChange={(e) => onSelectParent(e.target.value)}
              size={5}
              className="w-full border border-slate-200 rounded-xl px-2 py-1 text-sm font-mono"
            >
              <option value="">— Cuenta raíz (sin padre, nivel 1) —</option>
              {allAccounts
                .filter((a) => !editing || a._id !== editing._id)
                .filter((a) => {
                  const s = parentQuery.trim().toLowerCase();
                  return !s || a.code.toLowerCase().includes(s) || (a.name || '').toLowerCase().includes(s);
                })
                .slice(0, 200)
                .map((a) => (
                  <option key={a._id} value={a._id}>{' '.repeat((a.level - 1) * 2)}{a.code} · {a.name}</option>
                ))}
            </select>
            <p className="text-[11px] text-slate-400 mt-1">Elige la cuenta donde quieres colgar la nueva (ej. para crear un banco, elige “1.1.01 Caja y bancos”). El código se asigna automáticamente.</p>
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2"><label className="text-xs text-slate-600">Código *</label><input required value={form.code} onChange={(e) => setForm({ ...form, code: e.target.value, level: e.target.value.split('.').length })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 font-mono" /></div>
            <div><label className="text-xs text-slate-600">Nivel</label><input value={form.level} disabled className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 bg-slate-50 text-slate-500" /></div>
          </div>
          <div><label className="text-xs text-slate-600">Nombre *</label><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5" /></div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-slate-600">Tipo</label>
              <select value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
                <option>ACTIVO</option><option>PASIVO</option><option>PATRIMONIO</option>
                <option>INGRESO</option><option>GASTO</option><option>COSTO</option><option>ORDEN</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-slate-600">Naturaleza</label>
              <select value={form.nature} onChange={(e) => setForm({ ...form, nature: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5">
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
