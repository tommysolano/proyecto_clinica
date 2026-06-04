import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import { HiOutlineCalculator, HiOutlinePlus, HiOutlineEye } from 'react-icons/hi2';
import { fmt, fmtDate, today } from './_utils';

export default function CashClosing() {
  const [list, setList] = useState([]);
  const [show, setShow] = useState(false);
  const [summary, setSummary] = useState(null);
  const [view, setView] = useState(null);
  const [form, setForm] = useState({ date: today(), openingBalance: 0, countedCash: 0, notes: '' });

  const load = async () => {
    try { const r = await api.get('/cash-closings'); setList(r.data || []); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  useEffect(() => { load(); }, []);

  const loadSummary = async (date) => {
    try { const r = await api.get('/cash-closings/summary', { params: { date } }); setSummary(r.data); setForm((f) => ({ ...f, openingBalance: r.data.suggestedOpening || 0 })); }
    catch { setSummary(null); }
  };

  const openNew = () => { setForm({ date: today(), openingBalance: 0, countedCash: 0, notes: '' }); setShow(true); loadSummary(today()); };

  const expectedCash = (summary?.byMethod?.efectivo || 0) + (+form.openingBalance || 0);
  const difference = (+form.countedCash || 0) - expectedCash;

  const submit = async (e) => {
    e.preventDefault();
    try { await api.post('/cash-closings', form); toast.success('Cierre de caja registrado'); setShow(false); load(); }
    catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineCalculator className="text-emerald-600" /> Cierre de Caja</h1>
        <button onClick={openNew} className="px-4 py-2 bg-emerald-600 text-white rounded-lg flex items-center gap-2"><HiOutlinePlus /> Nuevo cierre</button>
      </div>

      <div className="bg-white rounded-xl shadow-sm overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-right">Fondo inicial</th>
            <th className="px-3 py-2 text-right">Efectivo ventas</th><th className="px-3 py-2 text-right">Esperado</th>
            <th className="px-3 py-2 text-right">Contado</th><th className="px-3 py-2 text-right">Diferencia</th>
            <th className="px-3 py-2 text-left">Cajero</th><th className="px-3 py-2 text-center">Estado</th><th></th>
          </tr></thead>
          <tbody>
            {list.map((c) => (
              <tr key={c._id} className="border-t hover:bg-slate-50">
                <td className="px-3 py-2">{fmtDate(c.date)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.openingBalance)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.byMethod?.efectivo)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.expectedCash)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(c.countedCash)}</td>
                <td className={`px-3 py-2 text-right font-mono font-semibold ${c.difference < 0 ? 'text-rose-600' : c.difference > 0 ? 'text-amber-600' : 'text-emerald-700'}`}>{fmt(c.difference)}</td>
                <td className="px-3 py-2 text-xs">{c.closedBy?.name || '—'}</td>
                <td className="px-3 py-2 text-center"><span className={`px-2 py-0.5 rounded-full text-[11px] ${c.status === 'CERRADO' ? 'bg-emerald-100 text-emerald-700' : 'bg-rose-100 text-rose-700'}`}>{c.status}</span></td>
                <td className="px-3 py-2 text-right"><button onClick={() => setView(c)} className="text-slate-500"><HiOutlineEye className="w-5 h-5" /></button></td>
              </tr>
            ))}
            {!list.length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">Sin cierres registrados</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Modal nuevo cierre */}
      <Modal isOpen={show} onClose={() => setShow(false)} title="Nuevo cierre de caja" size="lg">
        <form onSubmit={submit} className="space-y-3">
          <label className="text-xs text-slate-500 block">Fecha del cierre
            <input type="date" value={form.date} onChange={(e) => { setForm({ ...form, date: e.target.value }); loadSummary(e.target.value); }} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
          </label>

          {summary && (
            <div className="grid grid-cols-3 gap-2 text-sm">
              <div className="bg-emerald-50 rounded-lg p-2"><p className="text-xs text-emerald-700">Efectivo</p><p className="font-bold text-emerald-800">${fmt(summary.byMethod.efectivo)}</p></div>
              <div className="bg-sky-50 rounded-lg p-2"><p className="text-xs text-sky-700">Tarjeta</p><p className="font-bold text-sky-800">${fmt(summary.byMethod.tarjeta)}</p></div>
              <div className="bg-violet-50 rounded-lg p-2"><p className="text-xs text-violet-700">Transferencia</p><p className="font-bold text-violet-800">${fmt(summary.byMethod.transferencia)}</p></div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="text-xs text-slate-500 block">Fondo de caja inicial ($)
              <input type="number" step="0.01" value={form.openingBalance} onChange={(e) => setForm({ ...form, openingBalance: +e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-right" />
            </label>
            <label className="text-xs text-slate-500 block">Efectivo físico contado ($)
              <input type="number" step="0.01" value={form.countedCash} onChange={(e) => setForm({ ...form, countedCash: +e.target.value })} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm text-right" />
            </label>
          </div>

          <div className="bg-slate-50 rounded-lg p-3 flex flex-wrap justify-between gap-3 text-sm">
            <span>Efectivo esperado: <b className="font-mono">${fmt(expectedCash)}</b></span>
            <span>Contado: <b className="font-mono">${fmt(form.countedCash)}</b></span>
            <span>Diferencia: <b className={`font-mono ${difference < 0 ? 'text-rose-600' : difference > 0 ? 'text-amber-600' : 'text-emerald-700'}`}>${fmt(difference)} {difference < 0 ? '(faltante)' : difference > 0 ? '(sobrante)' : '(cuadrado)'}</b></span>
          </div>

          <label className="text-xs text-slate-500 block">Observaciones
            <textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} rows={2} className="mt-1 w-full border border-slate-200 rounded-lg px-3 py-2 text-sm" />
          </label>

          <div className="flex justify-end gap-2"><button type="button" onClick={() => setShow(false)} className="px-4 py-2 bg-slate-200 rounded-lg">Cancelar</button><button className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Registrar cierre</button></div>
        </form>
      </Modal>

      {/* Modal ver */}
      <Modal isOpen={!!view} onClose={() => setView(null)} title={`Cierre ${view ? fmtDate(view.date) : ''}`} size="md">
        {view && (
          <div className="space-y-2 text-sm">
            <div className="grid grid-cols-2 gap-2">
              <div><span className="text-slate-500">Fondo inicial:</span> ${fmt(view.openingBalance)}</div>
              <div><span className="text-slate-500">Efectivo ventas:</span> ${fmt(view.byMethod?.efectivo)}</div>
              <div><span className="text-slate-500">Esperado:</span> ${fmt(view.expectedCash)}</div>
              <div><span className="text-slate-500">Contado:</span> ${fmt(view.countedCash)}</div>
              <div><span className="text-slate-500">Diferencia:</span> <b className={view.difference < 0 ? 'text-rose-600' : view.difference > 0 ? 'text-amber-600' : 'text-emerald-700'}>${fmt(view.difference)}</b></div>
              <div><span className="text-slate-500">Ventas:</span> {view.salesCount} (${fmt(view.totalSales)})</div>
              <div><span className="text-slate-500">Tarjeta:</span> ${fmt(view.byMethod?.tarjeta)}</div>
              <div><span className="text-slate-500">Transferencia:</span> ${fmt(view.byMethod?.transferencia)}</div>
            </div>
            {view.notes && <p className="text-slate-600 border-t pt-2">{view.notes}</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}
