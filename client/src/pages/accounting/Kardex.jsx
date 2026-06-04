import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArchiveBox } from 'react-icons/hi2';
import { fmt, fmtDate } from './_utils';

const TYPE_COLOR = { entrada: 'text-emerald-600', salida: 'text-rose-600', ajuste: 'text-amber-600', traslado: 'text-blue-600' };
const TYPE_LABEL = { entrada: 'Ingreso', salida: 'Egreso', ajuste: 'Ajuste', traslado: 'Traslado' };

export default function Kardex() {
  const [products, setProducts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [filters, setFilters] = useState({ product: '', warehouse: '', type: '', startDate: '', endDate: '' });
  const [data, setData] = useState(null);

  useEffect(() => {
    api.get('/products').then((r) => setProducts(r.data || [])).catch(() => {});
    api.get('/inventory-advanced/warehouses').then((r) => setWarehouses(r.data || [])).catch(() => {});
  }, []);

  const load = async () => {
    if (!filters.product) return toast.error('Selecciona un producto');
    try {
      const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v));
      const r = await api.get('/inventory-advanced/kardex', { params });
      setData(r.data);
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineArchiveBox className="text-emerald-600" /> Kardex</h1>
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-3 grid grid-cols-1 md:grid-cols-6 gap-2">
        <select value={filters.product} onChange={(e) => setFilters({ ...filters, product: e.target.value })} className="md:col-span-2 px-3 py-2 border border-slate-200 rounded-lg">
          <option value="">Producto...</option>{products.map((p) => <option key={p._id} value={p._id}>{p.code} - {p.name}</option>)}
        </select>
        <select value={filters.warehouse} onChange={(e) => setFilters({ ...filters, warehouse: e.target.value })} className="px-3 py-2 border border-slate-200 rounded-lg">
          <option value="">Todas las bodegas</option>{warehouses.map((w) => <option key={w._id} value={w._id}>{w.name}</option>)}
        </select>
        <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })} className="px-3 py-2 border border-slate-200 rounded-lg">
          <option value="">Todos los tipos</option><option value="entrada">Ingreso</option><option value="salida">Egreso</option><option value="ajuste">Ajuste</option><option value="traslado">Traslado</option>
        </select>
        <input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} className="px-3 py-2 border border-slate-200 rounded-lg" />
        <input type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} className="px-3 py-2 border border-slate-200 rounded-lg" />
        <button onClick={load} className="md:col-span-6 px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20">Consultar</button>
      </div>

      {data && (
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
          <div className="p-3 border-b text-sm flex justify-between"><span className="font-semibold text-slate-700">{data.product?.code} — {data.product?.name}</span><span className="text-slate-500">Saldo actual: <span className="font-bold text-slate-800">{data.currentBalance} {data.product?.unit}</span></span></div>
          <table className="tbl">
            <thead className="bg-emerald-50 text-xs uppercase"><tr><th className="px-3 py-2 text-left">Fecha</th><th className="px-3 py-2 text-left">Tipo</th><th className="px-3 py-2 text-left">Bodega</th><th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 text-right">Costo unit.</th><th className="px-3 py-2 text-right">Saldo</th><th className="px-3 py-2 text-left">Referencia</th></tr></thead>
            <tbody>
              {data.movements.map((m) => (
                <tr key={m._id} className="border-t">
                  <td className="px-3 py-2 text-xs">{fmtDate(m.date)}</td>
                  <td className={`px-3 py-2 text-xs font-semibold ${TYPE_COLOR[m.type]}`}>{TYPE_LABEL[m.type] || m.type}</td>
                  <td className="px-3 py-2 text-xs">{m.type === 'traslado' ? `${m.warehouse?.name || '?'} → ${m.toWarehouse?.name || '?'}` : (m.warehouse?.name || '—')}</td>
                  <td className={`px-3 py-2 text-right font-mono ${m.signedQuantity < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>{m.signedQuantity > 0 ? '+' : ''}{m.signedQuantity}</td>
                  <td className="px-3 py-2 text-right font-mono">{m.unitCost ? fmt(m.unitCost) : '—'}</td>
                  <td className="px-3 py-2 text-right font-mono font-semibold">{m.balance}</td>
                  <td className="px-3 py-2 text-xs text-slate-500">{m.reason || m.reference || '—'}</td>
                </tr>
              ))}
              {data.movements.length === 0 && <tr><td colSpan={7} className="px-3 py-8 text-center text-slate-400">Sin movimientos</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
