import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import DateInput from '../../components/DateInput';
import { fmt, fmtDate, startOfMonth, today } from './_utils';

const methodLabel = { EFECTIVO: 'Efectivo', TARJETA: 'Tarjeta', TRANSFERENCIA: 'Transferencia', CHEQUE: 'Cheque', DEPOSITO: 'Depósito', OTRO: 'Otro' };

export default function CashierCollections() {
  const [range, setRange] = useState({ startDate: startOfMonth(), endDate: today() });
  const [data, setData] = useState({ total: 0, summary: [], events: [] });
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try { setData((await api.get('/accounting-reports/collections/by-cashier', { params: range })).data); }
    catch (e) { toast.error(e.response?.data?.message || 'No se pudieron cargar los cobros'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  return <div className="space-y-4">
    <div><h1 className="text-2xl font-bold text-slate-800">Cobros por cajero</h1>
      <p className="text-sm text-slate-500">Pagos recibidos en ventas, cartera y anticipos. Las ventas a crédito y los pagos con saldo a favor no suman como dinero nuevo.</p></div>
    <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-end gap-3">
      <label className="text-sm text-slate-700">Desde<DateInput value={range.startDate} onChange={(e) => setRange({ ...range, startDate: e.target.value })} className="block border border-slate-300 rounded-lg px-3 py-2" /></label>
      <label className="text-sm text-slate-700">Hasta<DateInput value={range.endDate} onChange={(e) => setRange({ ...range, endDate: e.target.value })} className="block border border-slate-300 rounded-lg px-3 py-2" /></label>
      <button onClick={load} disabled={loading} className="px-4 py-2 bg-emerald-600 text-white rounded-lg disabled:opacity-50">Consultar</button>
      <span className="ml-auto font-bold text-emerald-700">Total cobrado: ${fmt(data.total)}</span>
    </div>
    <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto"><table className="tbl w-full text-sm"><thead className="bg-slate-50"><tr><th className="px-3 py-2 text-left">Cajero</th><th className="px-3 py-2 text-right">Cobros</th><th className="px-3 py-2 text-right">Efectivo</th><th className="px-3 py-2 text-right">Tarjeta</th><th className="px-3 py-2 text-right">Transferencia</th><th className="px-3 py-2 text-right">Otros</th><th className="px-3 py-2 text-right">Total</th></tr></thead><tbody>
      {data.summary.map((r) => <tr key={r.cashier || 'sin-asignar'} className="border-t"><td className="px-3 py-2">{r.name}</td><td className="px-3 py-2 text-right">{r.count}</td><td className="px-3 py-2 text-right">{fmt(r.byMethod.EFECTIVO)}</td><td className="px-3 py-2 text-right">{fmt(r.byMethod.TARJETA)}</td><td className="px-3 py-2 text-right">{fmt(r.byMethod.TRANSFERENCIA)}</td><td className="px-3 py-2 text-right">{fmt((r.byMethod.CHEQUE || 0) + (r.byMethod.DEPOSITO || 0) + (r.byMethod.OTRO || 0))}</td><td className="px-3 py-2 text-right font-semibold">{fmt(r.total)}</td></tr>)}
      {!loading && !data.summary.length && <tr><td colSpan={7} className="text-center px-3 py-6 text-slate-500">Sin cobros en el período</td></tr>}
    </tbody></table></div>
    <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto"><h2 className="p-3 font-semibold text-slate-800">Detalle de cobros</h2><table className="tbl w-full text-sm"><thead className="bg-slate-50"><tr><th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Cajero</th><th className="px-3 py-2 text-left">Documento</th><th className="px-3 py-2 text-left">Origen</th><th className="px-3 py-2 text-left">Medio</th><th className="px-3 py-2 text-right">Importe</th></tr></thead><tbody>
      {data.events.map((e, i) => <tr key={`${e.origin}-${e.number}-${i}`} className="border-t"><td className="px-3 py-2">{fmtDate(e.date)}</td><td className="px-3 py-2">{e.cashierName}</td><td className="px-3 py-2 font-mono">{e.number || '—'}</td><td className="px-3 py-2">{e.origin === 'VENTA' ? 'Venta' : e.origin === 'COBRO_VENTA' ? 'Cobro de venta' : 'Cobro / anticipo'}</td><td className="px-3 py-2">{methodLabel[e.method] || e.method}</td><td className="px-3 py-2 text-right">{fmt(e.amount)}</td></tr>)}
    </tbody></table></div>
  </div>;
}
