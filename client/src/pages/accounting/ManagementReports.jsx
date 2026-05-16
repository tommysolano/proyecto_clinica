import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineChartBar } from 'react-icons/hi2';
import { fmt, fmtDate, startOfMonth, today } from './_utils';

export default function ManagementReports() {
  const [tab, setTab] = useState('VENTAS');
  const [startDate, setStart] = useState(startOfMonth());
  const [endDate, setEnd] = useState(today());
  const [data, setData] = useState(null);

  const URLS = {
    VENTAS: '/accounting-reports/sales/summary',
    PRODUCTO: '/accounting-reports/sales/by-product',
    CAJERO: '/accounting-reports/sales/by-cashier',
    SEMANAL: '/accounting-reports/sales/weekly',
    COSTO: '/accounting-reports/sales/cost',
    AR: '/accounting-reports/ar-aging',
    AP: '/accounting-reports/ap-aging',
    ANT: '/accounting-reports/advances',
    NODED: '/accounting-reports/non-deductible',
    INV: '/accounting-reports/inventory',
  };

  const load = async () => {
    try { const r = await api.get(URLS[tab], { params: { startDate, endDate } }); setData(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineChartBar className="text-emerald-600" /> Reportes Gerenciales</h1>
      <div className="flex gap-2 flex-wrap">
        {Object.keys(URLS).map((k) =>
          <button key={k} onClick={() => { setTab(k); setData(null); }} className={`px-3 py-2 rounded-lg text-xs ${tab === k ? 'bg-emerald-600 text-white' : 'bg-white border'}`}>{k}</button>)}
      </div>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end">
        <div><label className="text-xs text-slate-500">Desde</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <div><label className="text-xs text-slate-500">Hasta</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Generar</button>
      </div>
      {data && (
        <div className="bg-white rounded-xl p-4 shadow-sm overflow-auto">
          <pre className="text-xs">{JSON.stringify(data, null, 2)}</pre>
        </div>
      )}
    </div>
  );
}
