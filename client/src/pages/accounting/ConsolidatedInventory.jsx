import { useEffect, useMemo, useState, Fragment } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineCube, HiOutlineMagnifyingGlass, HiOutlineChevronDown, HiOutlineChevronRight } from 'react-icons/hi2';
import { fmt } from './_utils';

export default function ConsolidatedInventory() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  const [expanded, setExpanded] = useState({});

  const load = async () => {
    setLoading(true);
    try {
      const r = await api.get('/inventory/consolidated');
      setItems(r.data || []);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const filtered = useMemo(() => {
    if (!q.trim()) return items;
    const needle = q.toLowerCase();
    return items.filter((i) =>
      (i._id || '').toLowerCase().includes(needle) ||
      (i.name || '').toLowerCase().includes(needle) ||
      (i.category || '').toLowerCase().includes(needle)
    );
  }, [q, items]);

  const totals = useMemo(() => {
    return filtered.reduce((acc, i) => {
      acc.stock += i.totalStock || 0;
      acc.value += i.totalValue || 0;
      return acc;
    }, { stock: 0, value: 0 });
  }, [filtered]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineCube className="text-emerald-600" /> Inventario consolidado (todas las clínicas)
        </h1>
        <div className="flex items-center gap-2">
          <div className="relative">
            <HiOutlineMagnifyingGlass className="absolute left-2 top-2.5 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Buscar código, nombre o categoría..."
              className="pl-8 pr-3 py-2 border border-slate-200 rounded-lg text-sm w-72"
            />
          </div>
          <button onClick={load} className="px-3 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm">Recargar</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
          <div className="text-xs text-slate-500">SKUs totales</div>
          <div className="text-2xl font-bold text-slate-800 tracking-tight">{filtered.length}</div>
        </div>
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
          <div className="text-xs text-slate-500">Stock total (unidades)</div>
          <div className="text-2xl font-bold text-slate-800 tracking-tight">{fmt(totals.stock)}</div>
        </div>
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
          <div className="text-xs text-slate-500">Valor total inventario</div>
          <div className="text-2xl font-bold text-emerald-700">${fmt(totals.value)}</div>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-emerald-50 text-xs uppercase">
            <tr>
              <th className="w-8"></th>
              <th className="px-3 py-2 text-left">Código</th>
              <th className="px-3 py-2 text-left">Producto</th>
              <th className="px-3 py-2 text-left">Categoría</th>
              <th className="px-3 py-2 text-center">Clínicas</th>
              <th className="px-3 py-2 text-right">Stock total</th>
              <th className="px-3 py-2 text-right">Costo prom.</th>
              <th className="px-3 py-2 text-right">P. venta prom.</th>
              <th className="px-3 py-2 text-right">Valor</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">Cargando...</td></tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">Sin resultados</td></tr>
            )}
            {filtered.map((i) => {
              const isOpen = !!expanded[i._id];
              const avgCost = i.byClinic?.length
                ? i.byClinic.reduce((s, c) => s + (c.averageCost || c.purchasePrice || 0), 0) / i.byClinic.length
                : 0;
              return (
                <Fragment key={i._id}>
                  <tr className="border-t hover:bg-slate-50">
                    <td className="px-2 py-2 text-center">
                      <button onClick={() => setExpanded({ ...expanded, [i._id]: !isOpen })} className="text-slate-500">
                        {isOpen ? <HiOutlineChevronDown /> : <HiOutlineChevronRight />}
                      </button>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{i._id}</td>
                    <td className="px-3 py-2 font-medium">{i.name}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{i.category}</td>
                    <td className="px-3 py-2 text-center">
                      <span className="px-2 py-0.5 bg-emerald-100 text-emerald-700 rounded-full text-xs font-semibold">
                        {i.byClinic?.length || 0}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{fmt(i.totalStock)}</td>
                    <td className="px-3 py-2 text-right font-mono">${fmt(avgCost)}</td>
                    <td className="px-3 py-2 text-right font-mono">${fmt(i.avgSalePrice)}</td>
                    <td className="px-3 py-2 text-right font-mono font-semibold text-emerald-700">${fmt(i.totalValue)}</td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-slate-50/70">
                      <td></td>
                      <td colSpan={8} className="px-3 py-3">
                        <table className="w-full text-xs">
                          <thead className="text-slate-500">
                            <tr>
                              <th className="px-2 py-1 text-left">Clínica</th>
                              <th className="px-2 py-1 text-right">Stock</th>
                              <th className="px-2 py-1 text-right">Mínimo</th>
                              <th className="px-2 py-1 text-right">Costo prom.</th>
                              <th className="px-2 py-1 text-right">P. compra</th>
                              <th className="px-2 py-1 text-right">P. venta</th>
                              <th className="px-2 py-1 text-right">Valor</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(i.byClinic || []).map((c) => {
                              const lineCost = c.averageCost || c.purchasePrice || 0;
                              const lineValue = (c.stock || 0) * lineCost;
                              const low = c.minStock != null && c.stock < c.minStock;
                              return (
                                <tr key={c.productId} className="border-t border-slate-200">
                                  <td className="px-2 py-1">{c.clinicName || c.clinic}</td>
                                  <td className={`px-2 py-1 text-right font-mono ${low ? 'text-rose-600 font-semibold' : ''}`}>{fmt(c.stock)}{low ? ' ⚠' : ''}</td>
                                  <td className="px-2 py-1 text-right font-mono text-slate-500">{fmt(c.minStock)}</td>
                                  <td className="px-2 py-1 text-right font-mono">${fmt(c.averageCost)}</td>
                                  <td className="px-2 py-1 text-right font-mono">${fmt(c.purchasePrice)}</td>
                                  <td className="px-2 py-1 text-right font-mono">${fmt(c.salePrice)}</td>
                                  <td className="px-2 py-1 text-right font-mono">${fmt(lineValue)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
