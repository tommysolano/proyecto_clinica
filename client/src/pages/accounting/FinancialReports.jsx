import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineDocumentChartBar } from 'react-icons/hi2';
import { fmt, startOfMonth, today, downloadBlob } from './_utils';

export default function FinancialReports() {
  const [tab, setTab] = useState('PYG');
  const [startDate, setStart] = useState(startOfMonth());
  const [endDate, setEnd] = useState(today());
  const [data, setData] = useState(null);

  const load = async () => {
    try {
      const params = { startDate, endDate };
      let url = '/accounting-reports/income-statement';
      if (tab === 'BG') url = '/accounting-reports/balance-sheet';
      if (tab === 'FC') url = '/accounting-reports/cash-flow';
      const r = await api.get(url, { params });
      setData(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const downloadSupercias = async () => {
    try {
      const url =
        tab === 'BG'
          ? '/accounting-reports/supercias/balance-sheet.txt'
          : '/accounting-reports/supercias/income-statement.txt';
      const params = tab === 'BG' ? { date: endDate } : { startDate, endDate };
      const r = await api.get(url, { params, responseType: 'blob' });
      const fname =
        tab === 'BG'
          ? `supercias-balance-${endDate}.txt`
          : `supercias-resultados-${startDate}_${endDate}.txt`;
      downloadBlob(r.data, fname, 'text/plain');
      toast.success('TXT SuperCías descargado');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al descargar TXT');
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2"><HiOutlineDocumentChartBar className="text-emerald-600" /> Reportes Financieros</h1>
      <div className="flex gap-2">
        {[['PYG', 'Estado Resultados'], ['BG', 'Balance General'], ['FC', 'Flujo de Caja']].map(([k, l]) =>
          <button key={k} onClick={() => { setTab(k); setData(null); }} className={`px-4 py-2 rounded-lg text-sm ${tab === k ? 'bg-emerald-600 text-white' : 'bg-white border'}`}>{l}</button>)}
      </div>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end">
        <div><label className="text-xs text-slate-500">Desde</label><input type="date" value={startDate} onChange={(e) => setStart(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <div><label className="text-xs text-slate-500">Hasta</label><input type="date" value={endDate} onChange={(e) => setEnd(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2" /></div>
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-lg">Generar</button>
        {(tab === 'BG' || tab === 'PYG') && (
          <button
            onClick={downloadSupercias}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm"
            title="Archivo plano para subir a SuperCías"
          >
            Descargar TXT (SuperCías)
          </button>
        )}
      </div>
      {data && (
        <div className="bg-white rounded-xl p-4 shadow-sm">
          {tab === 'PYG' && <PYG data={data} />}
          {tab === 'BG' && <BG data={data} />}
          {tab === 'FC' && <FC data={data} />}
        </div>
      )}
    </div>
  );
}

function Section({ title, items, total, totalClass = '' }) {
  return (
    <div className="mb-4">
      <h3 className="font-semibold text-emerald-700 border-b pb-1">{title}</h3>
      {(items || []).map((r, i) => (
        <div key={i} className="flex justify-between py-1 text-sm border-b border-slate-100">
          <span><span className="font-mono text-xs text-slate-400 mr-2">{r.code}</span>{r.name}</span>
          <span className="font-mono">{fmt(r.balance ?? r.amount)}</span>
        </div>
      ))}
      <div className={`flex justify-between py-2 font-bold ${totalClass}`}>
        <span>Total {title}</span><span className="font-mono">${fmt(total)}</span>
      </div>
    </div>
  );
}

function PYG({ data }) {
  return (
    <div>
      <Section title="Ingresos" items={data.ingresos} total={data.totalIngresos} totalClass="text-emerald-700" />
      <Section title="Costo de Ventas" items={data.costos} total={data.totalCostos} totalClass="text-rose-600" />
      <div className="flex justify-between py-2 font-bold border-y bg-slate-50 px-2"><span>Utilidad Bruta</span><span className="font-mono">${fmt(data.utilidadBruta)}</span></div>
      <Section title="Gastos" items={data.gastos} total={data.totalGastos} totalClass="text-rose-600" />
      <div className="flex justify-between py-3 text-lg font-bold bg-emerald-50 px-2 mt-2"><span>Utilidad Neta</span><span className="font-mono">${fmt(data.utilidadNeta)}</span></div>
    </div>
  );
}
function BG({ data }) {
  return (
    <div>
      <Section title="Activos" items={data.activos} total={data.totalActivos} totalClass="text-emerald-700" />
      <Section title="Pasivos" items={data.pasivos} total={data.totalPasivos} totalClass="text-rose-600" />
      <Section title="Patrimonio" items={data.patrimonio} total={data.totalPatrimonio} totalClass="text-blue-700" />
      <div className="flex justify-between py-3 text-lg font-bold bg-emerald-50 px-2 mt-2"><span>Pasivo + Patrimonio</span><span className="font-mono">${fmt(data.totalPasivos + data.totalPatrimonio)}</span></div>
    </div>
  );
}
function FC({ data }) {
  return (
    <div>
      <Section title="Entradas de Efectivo" items={data.entradas} total={data.totalEntradas} totalClass="text-emerald-700" />
      <Section title="Salidas de Efectivo" items={data.salidas} total={data.totalSalidas} totalClass="text-rose-600" />
      <div className="flex justify-between py-3 text-lg font-bold bg-emerald-50 px-2 mt-2"><span>Flujo Neto</span><span className="font-mono">${fmt(data.flujoNeto)}</span></div>
    </div>
  );
}
