import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineChartPie } from 'react-icons/hi2';

const RANGES = [
  { value: 'month', label: 'Este mes' },
  { value: 'quarter', label: 'Trimestre' },
  { value: 'year', label: 'Año' },
];

export default function Attribution() {
  const [data, setData] = useState(null);
  const [range, setRange] = useState('month');
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const { data } = await api.get(`/marketing/attribution?range=${range}`);
      setData(data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al cargar atribución');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const maxRevenue = Math.max(1, ...(data?.rows || []).map((r) => r.revenue));

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <HiOutlineChartPie className="text-emerald-600" /> Atribución / ROI
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            Pacientes captados por origen y campaña, e ingresos de ventas que generaron.
          </p>
        </div>
        <label className="text-sm text-slate-600 flex items-center gap-2">
          <span>Rango</span>
          <select value={range} onChange={(e) => setRange(e.target.value)} className="border border-slate-200 rounded-lg px-3 py-2 text-sm">
            {RANGES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select>
        </label>
      </div>

      {data && (
        <div className="grid grid-cols-2 gap-4 mb-5">
          <div className="border border-slate-200 rounded-xl p-4 bg-white">
            <div className="text-xs text-slate-500">Pacientes captados</div>
            <div className="text-2xl font-bold">{data.totals.patients}</div>
          </div>
          <div className="border border-slate-200 rounded-xl p-4 bg-white">
            <div className="text-xs text-slate-500">Ingresos atribuidos</div>
            <div className="text-2xl font-bold text-emerald-600">${data.totals.revenue.toLocaleString()}</div>
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-slate-400">Cargando…</p>
      ) : (
        <div className="border border-slate-200 rounded-xl overflow-hidden bg-white">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-500 text-xs uppercase">
              <tr>
                <th className="text-left px-4 py-2">Origen</th>
                <th className="text-left px-4 py-2">Campaña</th>
                <th className="text-right px-4 py-2">Pacientes</th>
                <th className="text-right px-4 py-2">Ingresos</th>
                <th className="text-right px-4 py-2">$/paciente</th>
              </tr>
            </thead>
            <tbody>
              {(data?.rows || []).map((r, i) => (
                <tr key={i} className="border-t border-slate-100">
                  <td className="px-4 py-2 capitalize">{r.source}</td>
                  <td className="px-4 py-2 text-slate-500">{r.campaign || '—'}</td>
                  <td className="px-4 py-2 text-right">{r.patients}</td>
                  <td className="px-4 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="h-2 bg-emerald-100 rounded" style={{ width: `${(r.revenue / maxRevenue) * 80}px` }} />
                      <span className="font-medium">${r.revenue.toLocaleString()}</span>
                    </div>
                  </td>
                  <td className="px-4 py-2 text-right text-slate-500">
                    ${r.patients ? Math.round(r.revenue / r.patients).toLocaleString() : 0}
                  </td>
                </tr>
              ))}
              {(!data?.rows || data.rows.length === 0) && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-slate-400">Sin datos en el rango.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
