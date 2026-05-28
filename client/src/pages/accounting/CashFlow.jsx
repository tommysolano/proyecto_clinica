import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArrowsRightLeft, HiOutlineArrowDownTray, HiOutlineExclamationTriangle } from 'react-icons/hi2';
import { fmt, fmtDate, startOfMonth, today } from './_utils';

export default function CashFlow() {
  const [startDate, setStart] = useState(startOfMonth());
  const [endDate, setEnd] = useState(today());
  const [data, setData] = useState(null);

  const load = async () => {
    try { const r = await api.get('/accounting-reports/cash-flow', { params: { startDate, endDate } }); setData(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };
  const downloadXlsx = async () => {
    try {
      const res = await api.get('/accounting-reports/cash-flow.xlsx', { params: { startDate, endDate }, responseType: 'blob' });
      const u = URL.createObjectURL(res.data); const a = document.createElement('a'); a.href = u; a.download = 'flujo_caja.xlsx'; a.click(); URL.revokeObjectURL(u);
    } catch { toast.error('Error al exportar'); }
  };

  const negativeCount = data?.flows?.filter((f) => f.saldo < 0).length || 0;

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineArrowsRightLeft className="text-emerald-600" /> Flujo de Caja</h1>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end flex-wrap">
        <div><label className="text-xs text-slate-500 block">Desde</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <div><label className="text-xs text-slate-500 block">Hasta</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Generar</button>
        {data && <button onClick={downloadXlsx} className="px-4 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-2"><HiOutlineArrowDownTray /> Excel</button>}
      </div>

      {data && (
        <>
          {negativeCount > 0 && (
            <div className="bg-rose-50 border border-rose-200 rounded-xl p-3 flex items-center gap-2 text-rose-700">
              <HiOutlineExclamationTriangle className="w-5 h-5" /> <span className="text-sm font-semibold">Alerta: en {negativeCount} momento(s) el saldo de caja queda en negativo.</span>
            </div>
          )}
          <div className="grid grid-cols-3 gap-3">
            <Stat title="Total ingresos" value={`$${fmt(data.totalIn)}`} color="text-emerald-700" />
            <Stat title="Total egresos" value={`$${fmt(data.totalOut)}`} color="text-rose-600" />
            <Stat title="Saldo final" value={`$${fmt(data.saldoFinal)}`} color={data.saldoFinal < 0 ? 'text-rose-600' : 'text-slate-800'} />
          </div>
          <div className="bg-white rounded-xl shadow-sm overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Asiento</th><th className="px-3 py-2 text-left">Descripción</th><th className="px-3 py-2 text-right">Ingreso</th><th className="px-3 py-2 text-right">Egreso</th><th className="px-3 py-2 text-right">Saldo</th></tr></thead>
              <tbody>
                {data.flows.map((f, i) => (
                  <tr key={i} className={`border-t ${f.saldo < 0 ? 'bg-rose-50' : f.saldo < 500 ? 'bg-amber-50' : ''}`}>
                    <td className="px-3 py-2 text-xs">{fmtDate(f.date)}</td>
                    <td className="px-3 py-2 text-xs font-mono">{f.number}</td>
                    <td className="px-3 py-2 text-xs">{f.description}</td>
                    <td className="px-3 py-2 text-right font-mono text-emerald-600">{f.in ? fmt(f.in) : ''}</td>
                    <td className="px-3 py-2 text-right font-mono text-rose-600">{f.out ? fmt(f.out) : ''}</td>
                    <td className={`px-3 py-2 text-right font-mono font-semibold ${f.saldo < 0 ? 'text-rose-600' : 'text-slate-800'}`}>{fmt(f.saldo)}</td>
                  </tr>
                ))}
                {data.flows.length === 0 && <tr><td colSpan={6} className="px-3 py-8 text-center text-slate-400">Sin movimientos de caja en el período</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ title, value, color = 'text-slate-800' }) {
  return <div className="bg-white rounded-xl shadow-sm p-4"><p className="text-xs text-slate-500">{title}</p><p className={`text-2xl font-bold ${color}`}>{value}</p></div>;
}
