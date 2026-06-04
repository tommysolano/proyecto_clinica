import { useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineDocumentArrowDown } from 'react-icons/hi2';
import { fmt, downloadBlob } from './_utils';

export default function SriReports() {
  const [tab, setTab] = useState('F104');
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [data, setData] = useState(null);

  const URLS = { F104: '/accounting-reports/sri/form-104', F103: '/accounting-reports/sri/form-103', ATS: '/accounting-reports/sri/ats', VC: '/accounting-reports/sri/purchases-sales', RDEP: '/accounting-reports/sri/rdep', RET: '/accounting-reports/sri/retentions-received' };

  const load = async () => {
    try {
      const params = { year, month };
      if (tab === 'ATS') {
        const r = await api.get(URLS[tab], { params, responseType: 'blob' });
        downloadBlob(r.data, `ATS_${year}_${String(month).padStart(2, '0')}.xml`);
        toast.success('ATS descargado');
        return;
      }
      if (tab === 'RDEP') { const r = await api.get(URLS[tab], { params: { year } }); setData(r.data); return; }
      if (tab === 'RET') { const r = await api.get(URLS[tab], { params }); setData(r.data); return; }
      const r = await api.get(URLS[tab], { params }); setData(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const downloadRdepXml = async () => {
    try { const r = await api.get('/accounting-reports/sri/rdep', { params: { year, format: 'xml' }, responseType: 'blob' }); downloadBlob(r.data, `RDEP_${year}.xml`); toast.success('RDEP descargado'); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const downloadXml = async () => {
    try {
      const url =
        tab === 'F104'
          ? '/accounting-reports/sri/form-104.xml'
          : tab === 'F103'
          ? '/accounting-reports/sri/form-103.xml'
          : '/accounting-reports/sri/ats';
      const r = await api.get(url, { params: { year, month }, responseType: 'blob' });
      downloadBlob(r.data, `${tab}_${year}_${String(month).padStart(2, '0')}.xml`);
      toast.success('XML descargado');
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al descargar XML');
    }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineDocumentArrowDown className="text-emerald-600" /> Reportes SRI</h1>
      <div className="flex gap-2">
        {[['F104', 'Formulario 104 (IVA)'], ['F103', 'Formulario 103 (Retenciones)'], ['ATS', 'Anexo Trans Simplif (XML)'], ['RDEP', 'RDEP (Rel. dependencia)'], ['RET', 'Retenciones recibidas'], ['VC', 'Ventas/Compras']].map(([k, l]) =>
          <button key={k} onClick={() => { setTab(k); setData(null); }} className={`px-3 py-2 rounded-lg text-xs ${tab === k ? 'bg-emerald-600 text-white' : 'bg-white border'}`}>{l}</button>)}
      </div>
      <div className="bg-white p-3 rounded-xl shadow-sm flex gap-2 items-end">
        <div><label className="text-xs text-slate-500">Año</label><input type="number" value={year} onChange={(e) => setYear(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 w-24" /></div>
        <div><label className="text-xs text-slate-500">Mes</label><input type="number" min="1" max="12" value={month} onChange={(e) => setMonth(+e.target.value)} className="border border-slate-200 rounded-xl px-3.5 py-2.5 w-20" /></div>
        <button onClick={load} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">{tab === 'ATS' ? 'Descargar XML' : 'Generar'}</button>
        {tab === 'RDEP' && <button onClick={downloadRdepXml} className="px-4 py-2 bg-indigo-600 text-white rounded-lg flex items-center gap-1"><HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar XML</button>}
        {(tab === 'F103' || tab === 'F104') && (
          <button
            onClick={downloadXml}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg flex items-center gap-1"
          >
            <HiOutlineDocumentArrowDown className="w-4 h-4" /> Descargar XML (DIMM)
          </button>
        )}
        {tab === 'VC' && (
          <button
            onClick={async () => {
              try { const r = await api.get('/accounting-reports/sri/purchases-sales.xlsx', { params: { year, month }, responseType: 'blob' }); downloadBlob(r.data, `compras_ventas_${year}_${String(month).padStart(2, '0')}.xlsx`, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'); }
              catch (e) { toast.error('Error al exportar'); }
            }}
            className="px-4 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-1"
          >
            <HiOutlineDocumentArrowDown className="w-4 h-4" /> Excel
          </button>
        )}
      </div>
      {data && (
        <div className="bg-white rounded-xl p-4 shadow-sm overflow-auto">
          {Array.isArray(data) ? (
            <table className="tbl">
              <thead className="bg-emerald-50 text-xs uppercase"><tr>{Object.keys(data[0] || {}).map((k) => <th key={k} className="px-2 py-1 text-left">{k}</th>)}</tr></thead>
              <tbody>
                {data.map((row, i) => (
                  <tr key={i} className="border-t">
                    {Object.values(row).map((v, j) => <td key={j} className="px-2 py-1 text-xs">{typeof v === 'number' ? fmt(v) : String(v ?? '')}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <pre className="text-xs whitespace-pre-wrap">{JSON.stringify(data, null, 2)}</pre>
          )}
        </div>
      )}
    </div>
  );
}
