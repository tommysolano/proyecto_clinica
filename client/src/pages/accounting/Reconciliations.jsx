import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineScale, HiOutlineCheck } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

export default function Reconciliations() {
  const [list, setList] = useState([]);
  const [banks, setBanks] = useState([]);
  const [show, setShow] = useState(false);
  const [selected, setSelected] = useState(null);
  const [form, setForm] = useState({ bankAccount: '', periodStart: today(), periodEnd: today(), statementBalance: 0 });

  const load = async () => {
    try { const r = await api.get('/banks/reconciliations'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => {
    api.get('/banks/accounts').then((r) => setBanks(r.data || []));
    load();
  }, []);

  const start = async (e) => {
    e.preventDefault();
    try { const r = await api.post('/banks/reconciliations', form); setSelected(r.data); setShow(false); load(); toast.success('Iniciada'); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const toggle = (idx) => {
    const items = [...selected.items];
    items[idx].matched = !items[idx].matched;
    setSelected({ ...selected, items });
  };
  const save = async () => {
    try { await api.put(`/banks/reconciliations/${selected._id}`, { items: selected.items, statementBalance: selected.statementBalance }); toast.success('Guardado'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const close = async () => {
    if (!confirm('¿Cerrar conciliación?')) return;
    try { await api.put(`/banks/reconciliations/${selected._id}`, { items: selected.items, statementBalance: selected.statementBalance }); const r = await api.post(`/banks/reconciliations/${selected._id}/close`); setSelected(r.data); load(); toast.success('Cerrada'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineScale className="text-emerald-600" /> Conciliaciones Bancarias</h1>
        <button onClick={() => setShow(true)} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-emerald-50 text-xs"><tr><th className="px-2 py-2 text-left">Banco</th><th className="px-2 py-2 text-left">Período</th><th className="px-2 py-2 text-center">Estado</th></tr></thead>
            <tbody>
              {list.map((c) => (
                <tr key={c._id} className="border-t cursor-pointer hover:bg-slate-50" onClick={() => setSelected(c)}>
                  <td className="px-2 py-2 text-xs">{c.bankAccount?.name}</td>
                  <td className="px-2 py-2 text-xs">{fmtDate(c.periodEnd)}</td>
                  <td className="px-2 py-2 text-center text-xs">{c.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {selected && (
          <div className="md:col-span-2 bg-white rounded-xl p-4 shadow-sm">
            <div className="flex justify-between items-center mb-3">
              <h2 className="font-semibold">{selected.bankAccount?.name} — {selected.status}</h2>
              {selected.status === 'EN_PROCESO' && <div className="flex gap-2">
                <input type="number" step="0.01" value={selected.statementBalance} onChange={(e) => setSelected({ ...selected, statementBalance: +e.target.value })} className="w-32 border border-slate-200 rounded px-2 py-1 text-right text-sm" placeholder="Saldo extracto" />
                <button onClick={save} className="px-3 py-1.5 bg-slate-600 text-white rounded text-sm">Guardar</button>
                <button onClick={close} className="px-3 py-1.5 bg-emerald-600 text-white rounded text-sm flex items-center gap-1"><HiOutlineCheck /> Cerrar</button>
              </div>}
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-100 text-xs"><tr>
                <th className="px-2 py-1 text-left">Fecha</th><th className="px-2 py-1 text-left">Tipo</th>
                <th className="px-2 py-1 text-left">Desc</th><th className="px-2 py-1 text-right">Monto</th>
                <th className="px-2 py-1 text-center">✓</th>
              </tr></thead>
              <tbody>
                {selected.items?.map((it, i) => (
                  <tr key={i} className="border-t">
                    <td className="px-2 py-1">{fmtDate(it.date)}</td>
                    <td className="px-2 py-1 text-xs">{it.type}</td>
                    <td className="px-2 py-1 text-xs">{it.description}</td>
                    <td className={`px-2 py-1 text-right font-mono ${it.direction > 0 ? 'text-emerald-700' : 'text-rose-600'}`}>${fmt(it.amount)}</td>
                    <td className="px-2 py-1 text-center"><input type="checkbox" disabled={selected.status !== 'EN_PROCESO'} checked={!!it.matched} onChange={() => toggle(i)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <Modal isOpen={show} onClose={() => setShow(false)} title="Nueva conciliación">
        <form onSubmit={start} className="space-y-3">
          <select required value={form.bankAccount} onChange={(e) => setForm({ ...form, bankAccount: e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2">
            <option value="">Cuenta...</option>{banks.map((b) => <option key={b._id} value={b._id}>{b.name}</option>)}
          </select>
          <div className="grid grid-cols-2 gap-3">
            <input type="date" required value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input type="date" required value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
          </div>
          <input type="number" step="0.01" placeholder="Saldo extracto" value={form.statementBalance} onChange={(e) => setForm({ ...form, statementBalance: +e.target.value })} className="w-full border border-slate-200 rounded-lg px-3 py-2" />
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Iniciar</button></div>
        </form>
      </Modal>
    </div>
  );
}
