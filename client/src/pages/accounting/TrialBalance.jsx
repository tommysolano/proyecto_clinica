import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineScale } from 'react-icons/hi2';
import { fmt, startOfMonth, today } from './_utils';

export default function TrialBalance() {
  const [startDate, setStart] = useState(startOfMonth());
  const [endDate, setEnd] = useState(today());
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState({ debit: 0, credit: 0 });

  const load = async () => {
    try {
      const r = await api.get('/journal-entries/trial-balance', { params: { startDate, endDate } });
      setRows(r.data.rows || []);
      setTotals(r.data.totals || { debit: 0, credit: 0 });
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineScale className="text-emerald-600" /> Balance de Comprobación</h1>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end">
        <div><label className="text-xs text-slate-500">Desde</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <div><label className="text-xs text-slate-500">Hasta</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <button type="button" onClick={load} className="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg cursor-pointer">Consultar</button>
      </div>
      <div className="bg-white rounded-2xl shadow-sm overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Código</th><th className="px-3 py-2 text-left">Cuenta</th>
            <th className="px-3 py-2 text-right">Débitos</th><th className="px-3 py-2 text-right">Créditos</th>
            <th className="px-3 py-2 text-right">Saldo</th>
          </tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-t">
                <td className="px-3 py-2 font-mono text-xs">{r.code}</td>
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(r.debit)}</td>
                <td className="px-3 py-2 text-right font-mono">{fmt(r.credit)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">{fmt(r.saldo)}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-6 text-center text-slate-400 text-xs">Sin datos. Selecciona un rango y presiona Consultar.</td></tr>
            )}
          </tbody>
          <tfoot className="bg-slate-100 font-bold">
            <tr><td colSpan={2} className="px-3 py-2 text-right">TOTALES</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(totals.debit)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(totals.credit)}</td>
              <td className="px-3 py-2 text-right font-mono">{fmt(totals.debit - totals.credit)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
