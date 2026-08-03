import { useEffect, useState, useCallback } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { fmt, startOfMonth, endOfMonth } from './_utils';
import ExcelButton from '../../components/ExcelButton';

export default function Profitability() {
  const [rows, setRows] = useState([]);
  const [from, setFrom] = useState(startOfMonth());
  const [to, setTo] = useState(endOfMonth());

  const load = useCallback(async () => {
    try {
      const r = await api.get('/accounting-reports/profitability/by-doctor', { params: { from, to } });
      setRows(r.data?.rows || []);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  }, [from, to]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight">Rentabilidad por Médico</h1>
      <div className="flex gap-2 items-end">
        <div><label className="text-xs text-slate-500">Desde</label><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="block border border-slate-200 rounded-xl px-3 py-2" /></div>
        <div><label className="text-xs text-slate-500">Hasta</label><input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="block border border-slate-200 rounded-xl px-3 py-2" /></div>
        <ExcelButton
          url="/accounting-reports/profitability/by-doctor.xlsx"
          params={{ from, to }}
          filename={`rentabilidad_medico_${from}_${to}.xlsx`}
        />
      </div>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 overflow-hidden">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Médico</th><th className="px-3 py-2 text-right">Ingreso</th>
            <th className="px-3 py-2 text-right">Costo</th><th className="px-3 py-2 text-right">Gasto</th>
            <th className="px-3 py-2 text-right">Margen</th>
          </tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.doctor)} className="border-t border-slate-100 hover:bg-slate-50">
                <td className="px-3 py-2">{r.doctorName}</td>
                <td className="px-3 py-2 text-right">${fmt(r.ingreso)}</td>
                <td className="px-3 py-2 text-right text-slate-500">${fmt(r.costo)}</td>
                <td className="px-3 py-2 text-right text-slate-500">${fmt(r.gasto)}</td>
                <td className={`px-3 py-2 text-right font-semibold ${r.margen >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>${fmt(r.margen)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">Sin datos. Asigna médico a las ventas para ver rentabilidad.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
