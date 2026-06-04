import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlineCreditCard, HiOutlinePlus, HiOutlinePencilSquare, HiOutlineTrash } from 'react-icons/hi2';

const EMPTY = { name: '', brand: 'VISA', acquirer: '', accountType: 'CREDITO', chartAccount: '', commissionRate: 0, retentionRate: 0, pos: [], active: true };

export default function CreditCards() {
  const [list, setList] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [show, setShow] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    try { const r = await api.get('/banks/cards'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    load();
    api.get('/chart-of-accounts', { params: { active: true } }).then((r) => setAccounts((r.data || []).filter((a) => a.allowsMovement))).catch(() => {});
  }, []);

  const idOf = (v) => (v && typeof v === 'object' ? v._id : v) || '';
  const openEdit = (c) => { setEditing(c); setForm({ ...EMPTY, ...c, chartAccount: idOf(c.chartAccount), pos: c.pos || [] }); setShow(true); };

  const submit = async (e) => {
    e.preventDefault();
    const payload = { ...form }; if (!payload.chartAccount) payload.chartAccount = null;
    try {
      if (editing) await api.put(`/banks/cards/${editing._id}`, payload);
      else await api.post('/banks/cards', payload);
      toast.success('Guardado'); setShow(false); setEditing(null); setForm(EMPTY); load();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const remove = async (c) => { if (!confirm('¿Eliminar?')) return; try { await api.delete(`/banks/cards/${c._id}`); load(); } catch (e) { toast.error(e.response?.data?.message || 'Error'); } };

  const addPos = () => setForm((f) => ({ ...f, pos: [...f.pos, { code: '', name: '', terminal: '', commissionRate: 0, active: true }] }));
  const updatePos = (i, k, v) => setForm((f) => ({ ...f, pos: f.pos.map((p, idx) => idx === i ? { ...p, [k]: v } : p) }));
  const removePos = (i) => setForm((f) => ({ ...f, pos: f.pos.filter((_, idx) => idx !== i) }));
  const inputCls = 'border border-slate-200 rounded-lg px-3 py-2';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineCreditCard className="text-emerald-600" /> Tarjetas de Crédito / POS</h1>
        <button onClick={() => { setEditing(null); setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
      </div>
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Nombre</th><th className="px-3 py-2 text-left">Marca</th><th className="px-3 py-2 text-left">Adquiriente</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-right">% Comisión</th><th className="px-3 py-2 text-center">POS</th><th></th></tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c._id} className="border-t">
                <td className="px-3 py-2">{c.name}</td>
                <td className="px-3 py-2 text-xs">{c.brand}</td>
                <td className="px-3 py-2 text-xs">{c.acquirer || '—'}</td>
                <td className="px-3 py-2 text-xs">{c.accountType}</td>
                <td className="px-3 py-2 text-right">{c.commissionRate}%</td>
                <td className="px-3 py-2 text-center">{c.pos?.length || 0}</td>
                <td className="px-3 py-2 flex gap-1 justify-end">
                  <button onClick={() => openEdit(c)} className="text-blue-600"><HiOutlinePencilSquare className="w-4 h-4" /></button>
                  <button onClick={() => remove(c)} className="text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
                </td>
              </tr>
            ))}
            {list.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Sin tarjetas registradas</td></tr>}
          </tbody>
        </table>
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title={editing ? 'Editar tarjeta' : 'Nueva tarjeta'} size="lg">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <input required placeholder="Nombre" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={inputCls} />
            <select value={form.brand} onChange={(e) => setForm({ ...form, brand: e.target.value })} className={inputCls}><option>VISA</option><option>MASTERCARD</option><option>AMEX</option><option>DINERS</option><option>DISCOVER</option><option>OTRA</option></select>
            <input placeholder="Adquiriente (Datafast, Medianet...)" value={form.acquirer} onChange={(e) => setForm({ ...form, acquirer: e.target.value })} className={inputCls} />
            <select value={form.accountType} onChange={(e) => setForm({ ...form, accountType: e.target.value })} className={inputCls}><option value="CREDITO">Crédito</option><option value="DEBITO">Débito</option><option value="CORRIENTE">Corriente</option></select>
            <input type="number" step="0.01" placeholder="% Comisión" value={form.commissionRate} onChange={(e) => setForm({ ...form, commissionRate: +e.target.value })} className={inputCls} />
            <input type="number" step="0.01" placeholder="% Retención" value={form.retentionRate} onChange={(e) => setForm({ ...form, retentionRate: +e.target.value })} className={inputCls} />
            <select value={form.chartAccount} onChange={(e) => setForm({ ...form, chartAccount: e.target.value })} className={`${inputCls} col-span-2`}><option value="">Cuenta contable...</option>{accounts.map((a) => <option key={a._id} value={a._id}>{a.code} - {a.name}</option>)}</select>
          </div>
          <div>
            <div className="flex items-center justify-between mb-1"><p className="text-xs font-semibold text-slate-500">POS / Terminales</p><button type="button" onClick={addPos} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus className="w-4 h-4" /> Agregar POS</button></div>
            <div className="space-y-2">
              {form.pos.map((p, i) => (
                <div key={i} className="grid grid-cols-12 gap-2 items-center">
                  <input placeholder="Código" value={p.code} onChange={(e) => updatePos(i, 'code', e.target.value)} className="col-span-3 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                  <input placeholder="Nombre" value={p.name} onChange={(e) => updatePos(i, 'name', e.target.value)} className="col-span-3 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                  <input placeholder="Terminal" value={p.terminal} onChange={(e) => updatePos(i, 'terminal', e.target.value)} className="col-span-3 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                  <input type="number" step="0.01" placeholder="% Com." value={p.commissionRate} onChange={(e) => updatePos(i, 'commissionRate', +e.target.value)} className="col-span-2 border border-slate-200 rounded-lg px-2 py-1.5 text-sm" />
                  <button type="button" onClick={() => removePos(i)} className="col-span-1 text-rose-600"><HiOutlineTrash className="w-4 h-4" /></button>
                </div>
              ))}
              {form.pos.length === 0 && <p className="text-xs text-slate-400">Sin POS configurados</p>}
            </div>
          </div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Guardar</button></div>
        </form>
      </Modal>
    </div>
  );
}
