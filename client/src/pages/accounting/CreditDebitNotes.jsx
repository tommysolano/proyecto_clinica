import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlinePlus, HiOutlineDocumentMinus, HiOutlineXMark } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

const EMPTY = { kind: 'NC', direction: 'RECIBIDA', date: today(), serie: '', serieAfecta: '', motivo: '', items: [{ description: '', quantity: 1, unitPrice: 0, ivaRate: 15 }] };

export default function CreditDebitNotes() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [form, setForm] = useState(EMPTY);

  const load = async () => {
    try { const r = await api.get('/credit-debit-notes'); setList(r.data?.items || r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); }, []);

  const setItem = (i, patch) => {
    const items = [...form.items]; items[i] = { ...items[i], ...patch }; setForm({ ...form, items });
  };
  const totals = (() => {
    let sub = 0, iva = 0;
    for (const it of form.items) {
      const b = it.quantity * it.unitPrice;
      sub += b; iva += b * (it.ivaRate || 0) / 100;
    }
    return { subtotal: sub, iva, total: sub + iva };
  })();

  const submit = async (e) => {
    e.preventDefault();
    try { await api.post('/credit-debit-notes', form); toast.success('Registrada'); setShow(false); setForm(EMPTY); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineDocumentMinus className="text-emerald-600" /> Notas de Crédito / Débito</h1>
        <button onClick={() => { setForm(EMPTY); setShow(true); }} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2"><HiOutlinePlus /> Nueva</button>
      </div>
      <div className="bg-white rounded-xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Sentido</th>
            <th className="px-3 py-2 text-left">Serie</th><th className="px-3 py-2 text-left">Afecta</th>
            <th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2 text-center">Estado</th>
          </tr></thead>
          <tbody>
            {list.map((n) => (
              <tr key={n._id} className="border-t">
                <td className="px-3 py-2 text-xs">{n.kind}</td>
                <td className="px-3 py-2 text-xs">{n.direction}</td>
                <td className="px-3 py-2 font-mono text-xs">{n.serie}</td>
                <td className="px-3 py-2 font-mono text-xs">{n.serieAfecta}</td>
                <td className="px-3 py-2">{fmtDate(n.date)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(n.total)}</td>
                <td className="px-3 py-2 text-center text-xs">{n.estado}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={show} onClose={() => setShow(false)} title="Nueva nota" size="xl">
        <form onSubmit={submit} className="space-y-3">
          <div className="grid grid-cols-4 gap-3">
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>NC</option><option>ND</option></select>
            <select value={form.direction} onChange={(e) => setForm({ ...form, direction: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2"><option>EMITIDA</option><option>RECIBIDA</option></select>
            <input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Serie" value={form.serie} onChange={(e) => setForm({ ...form, serie: e.target.value })} className="border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Serie que afecta" value={form.serieAfecta} onChange={(e) => setForm({ ...form, serieAfecta: e.target.value })} className="col-span-2 border border-slate-200 rounded-lg px-3 py-2" />
            <input placeholder="Motivo" value={form.motivo} onChange={(e) => setForm({ ...form, motivo: e.target.value })} className="col-span-2 border border-slate-200 rounded-lg px-3 py-2" />
          </div>
          <table className="w-full text-sm">
            <thead className="bg-slate-100 text-xs"><tr><th>Descripción</th><th>Cant.</th><th>P.U.</th><th>IVA%</th><th></th></tr></thead>
            <tbody>
              {form.items.map((it, i) => (
                <tr key={i}>
                  <td><input required value={it.description} onChange={(e) => setItem(i, { description: e.target.value })} className="w-full border border-slate-200 rounded px-2 py-1" /></td>
                  <td><input type="number" step="0.01" value={it.quantity} onChange={(e) => setItem(i, { quantity: +e.target.value })} className="w-16 border border-slate-200 rounded px-1 py-1 text-right" /></td>
                  <td><input type="number" step="0.01" value={it.unitPrice} onChange={(e) => setItem(i, { unitPrice: +e.target.value })} className="w-24 border border-slate-200 rounded px-1 py-1 text-right" /></td>
                  <td><select value={it.ivaRate} onChange={(e) => setItem(i, { ivaRate: +e.target.value })} className="border border-slate-200 rounded px-1 py-1"><option value={0}>0%</option><option value={15}>15%</option></select></td>
                  <td><button type="button" onClick={() => setForm({ ...form, items: form.items.filter((_, x) => x !== i) })} className="text-rose-600"><HiOutlineXMark /></button></td>
                </tr>
              ))}
            </tbody>
          </table>
          <button type="button" onClick={() => setForm({ ...form, items: [...form.items, { description: '', quantity: 1, unitPrice: 0, ivaRate: 15 }] })} className="text-emerald-600 text-sm">+ Línea</button>
          <div className="text-right text-sm">Subt: <b>{fmt(totals.subtotal)}</b> | IVA: <b>{fmt(totals.iva)}</b> | Total: <b className="text-lg">${fmt(totals.total)}</b></div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Registrar</button></div>
        </form>
      </Modal>
    </div>
  );
}
