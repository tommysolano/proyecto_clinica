import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import { HiOutlineChartBar, HiOutlineArrowDownTray, HiOutlinePlus, HiOutlineTag, HiOutlineTrash, HiOutlinePencilSquare } from 'react-icons/hi2';
import { BarChart, Bar, LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import { fmt, startOfMonth, endOfMonth } from './_utils';
import { downloadFile } from '../../utils/download';
import SalesDetailReport from './_SalesDetailReport';

const COLORS = ['#10b981', '#0ea5e9', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
const METHOD_LABELS = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia' };

/** Cabecera compartida por las dos vistas: rango y cambio de pestaña. */
function Cabecera({ vista, setVista, rango, setRango }) {
  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
        <HiOutlineChartBar className="text-emerald-600" /> Reportes de Ventas
      </h1>
      <div className="flex items-end gap-2">
        <label className="text-xs text-slate-500">Desde
          <input type="date" value={rango.startDate} onChange={(e) => setRango({ ...rango, startDate: e.target.value })}
            className="block border border-slate-200 rounded-lg px-2 py-1.5" />
        </label>
        <label className="text-xs text-slate-500">Hasta
          <input type="date" value={rango.endDate} onChange={(e) => setRango({ ...rango, endDate: e.target.value })}
            className="block border border-slate-200 rounded-lg px-2 py-1.5" />
        </label>
        <button onClick={() => setVista(vista === 'detalle' ? 'resumen' : 'detalle')}
          className="px-3 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-sm">
          {vista === 'detalle' ? 'Ver gráficos' : 'Detalle conciliable'}
        </button>
      </div>
    </div>
  );
}

export default function SalesReports() {
  const [vista, setVista] = useState('resumen');   // resumen (gráficos) | detalle (conciliable)
  const [products, setProducts] = useState([]);
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({ startDate: startOfMonth(), endDate: endOfMonth(), products: [], categories: [] });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const [showCat, setShowCat] = useState(false);
  const [catForm, setCatForm] = useState({ name: '', description: '', products: [] });
  const [editCatId, setEditCatId] = useState(null);
  const [prodSearch, setProdSearch] = useState('');
  const [catProdSearch, setCatProdSearch] = useState('');

  const loadMeta = async () => {
    const [p, c] = await Promise.all([
      api.get('/products', { params: { limit: 500 } }).catch(() => ({ data: [] })),
      api.get('/sales-reports/categories').catch(() => ({ data: [] })),
    ]);
    setProducts(p.data.products || p.data || []);
    setCategories(c.data || []);
  };
  useEffect(() => { loadMeta(); }, []);

  const params = () => ({
    startDate: filters.startDate, endDate: filters.endDate,
    products: filters.products.join(','), categories: filters.categories.join(','),
  });

  const run = async () => {
    setLoading(true);
    try { const r = await api.get('/sales-reports/summary', { params: params() }); setData(r.data); }
    catch (e) { toast.error(e.response?.data?.message || 'Error'); }
    finally { setLoading(false); }
  };
  // Carga inicial: el resto de consultas las dispara el botón (no se re-consulta al teclear).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { run(); }, []);

  /**
   * Excel DETALLADO: sale del mismo motor que la pantalla (`buildSalesReport`) y trae
   * cuatro hojas — Ventas (una fila por documento), Detalle (una por línea), Pagos
   * (una por cobro real, con el método, si la tarjeta fue de crédito o débito, la
   * cuenta y la referencia: así un pago mixto se ve partido en sus componentes) y
   * Resumen. Antes este botón apuntaba a `/sales-reports/excel`, la exportación
   * vieja de dos hojas que no desglosaba los pagos.
   */
  const downloadExcel = async () => {
    try {
      await downloadFile('/sales-reports/report.xlsx', {
        params: params(),
        filename: `reporte-ventas_${filters.startDate}_${filters.endDate}.xlsx`,
      });
    } catch (e) { toast.error(e.message || 'Error al exportar'); }
  };

  /**
   * Excel de VENTAS en el formato con el que trabaja la contadora: exactamente el mismo
   * archivo que se baja desde la pantalla de Ventas (una fila por venta, con el desglose
   * por forma de pago, la factura y el estado del SRI), pero acotado a los filtros de
   * este reporte. Lo arma el mismo servicio del servidor, así que no pueden divergir.
   */
  const downloadVentasExcel = async () => {
    try {
      await downloadFile('/sales-reports/ventas.xlsx', {
        params: params(),
        filename: `ventas_${filters.startDate}_${filters.endDate}.xlsx`,
      });
    } catch (e) { toast.error(e.message || 'Error al exportar'); }
  };

  const toggleProduct = (id) => setFilters((f) => ({ ...f, products: f.products.includes(id) ? f.products.filter((x) => x !== id) : [...f.products, id] }));
  const toggleCategory = (id) => setFilters((f) => ({ ...f, categories: f.categories.includes(id) ? f.categories.filter((x) => x !== id) : [...f.categories, id] }));

  // Categorías
  const openNewCat = () => { setEditCatId(null); setCatForm({ name: '', description: '', products: [] }); setShowCat(true); };
  const openEditCat = (c) => { setEditCatId(c._id); setCatForm({ name: c.name, description: c.description || '', products: (c.products || []).map((p) => p._id || p) }); setShowCat(true); };
  const saveCat = async (e) => {
    e.preventDefault();
    try {
      if (editCatId) await api.put(`/sales-reports/categories/${editCatId}`, catForm);
      else await api.post('/sales-reports/categories', catForm);
      toast.success('Categoría guardada'); setShowCat(false); loadMeta();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
  };
  const delCat = async (c) => { if (!confirm(`¿Eliminar categoría "${c.name}"?`)) return; try { await api.delete(`/sales-reports/categories/${c._id}`); loadMeta(); } catch { toast.error('Error'); } };
  const toggleCatProduct = (id) => setCatForm((f) => ({ ...f, products: f.products.includes(id) ? f.products.filter((x) => x !== id) : [...f.products, id] }));

  const g = data?.general || {};
  const v = data?.voided || {};
  const collectionsData = (data?.collections || []).map((c) => ({ name: METHOD_LABELS[c._id] || c._id || 'Otro', value: c.total, count: c.count }));
  const topServices = (data?.byService || []).slice(0, 12).map((s) => ({ name: s.name || s.code || '—', total: s.total, quantity: s.quantity }));

  const KPI = ({ label, value, sub, color = 'text-slate-800' }) => (
    <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
      <p className="text-xs text-slate-500">{label}</p>
      <p className={`text-2xl font-bold ${color}`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );

  if (vista === 'detalle') {
    return (
      <div className="space-y-4">
        <Cabecera vista={vista} setVista={setVista} rango={filters} setRango={setFilters} />
        {/* Reporte CONCILIABLE: documentos, líneas y pagos reales (motor único del backend). */}
        <SalesDetailReport
          rango={{ startDate: filters.startDate, endDate: filters.endDate }}
          categories={categories}
          products={products}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2"><HiOutlineChartBar className="text-emerald-600" /> Reportes de Ventas</h1>
        <div className="flex gap-2">
          <button onClick={() => setVista('detalle')} className="px-3 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg text-sm">
            Detalle conciliable
          </button>
          <button onClick={openNewCat} className="px-3 py-2 bg-slate-700 text-white rounded-lg flex items-center gap-2 text-sm"><HiOutlineTag /> Categorías</button>
          {/* El formato del contador (idéntico al de la pantalla de Ventas) va primero:
              es el que se usa a diario. El conciliable de 4 hojas queda al lado. */}
          <button onClick={downloadVentasExcel} title="Una fila por venta con el desglose por forma de pago, la factura y el estado del SRI (el mismo archivo de la pantalla de Ventas)"
            className="px-3 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 flex items-center gap-2 text-sm"><HiOutlineArrowDownTray /> Excel de ventas</button>
          <button onClick={downloadExcel} title="Reporte conciliable: documentos, líneas, pagos y resumen (4 hojas)"
            className="px-3 py-2 bg-white border border-emerald-200 text-emerald-700 rounded-xl flex items-center gap-2 text-sm"><HiOutlineArrowDownTray /> Conciliable (4 hojas)</button>
        </div>
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-500">Desde
            <input type="date" value={filters.startDate} onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} className="mt-1 block border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </label>
          <label className="text-xs text-slate-500">Hasta
            <input type="date" value={filters.endDate} onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} className="mt-1 block border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" />
          </label>
          <button onClick={run} className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm">{loading ? 'Cargando...' : 'Generar'}</button>
        </div>
        {/* Categorías guardadas como chips */}
        {!!categories.length && (
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-slate-500 self-center mr-1">Categorías:</span>
            {categories.map((c) => (
              <button key={c._id} onClick={() => toggleCategory(c._id)} className={`px-2.5 py-1 rounded-full text-xs border ${filters.categories.includes(c._id) ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-slate-600 border-slate-200'}`}>{c.name}</button>
            ))}
          </div>
        )}
        {/* Productos/servicios multiselección con buscador */}
        <details>
          <summary className="cursor-pointer text-xs text-slate-500">Filtrar por producto/servicio ({filters.products.length} seleccionados)</summary>
          <div className="mt-2 space-y-2">
            <div className="flex items-center gap-2">
              <input
                value={prodSearch}
                onChange={(e) => setProdSearch(e.target.value)}
                placeholder="Buscar producto o servicio..."
                className="flex-1 border border-slate-200 rounded-xl px-3 py-2 text-xs"
              />
              {!!filters.products.length && (
                <button type="button" onClick={() => setFilters((f) => ({ ...f, products: [] }))} className="text-xs text-rose-600">Limpiar ({filters.products.length})</button>
              )}
            </div>
            <div className="max-h-40 overflow-y-auto grid grid-cols-2 md:grid-cols-4 gap-1">
              {products
                .filter((p) => {
                  const q = prodSearch.trim().toLowerCase();
                  if (!q) return true;
                  return p.name?.toLowerCase().includes(q) || p.code?.toLowerCase().includes(q);
                })
                .map((p) => (
                  <label key={p._id} className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={filters.products.includes(p._id)} onChange={() => toggleProduct(p._id)} />
                    <span className="truncate" title={p.name}>{p.name}</span>
                  </label>
                ))}
              {!products.length && <span className="text-xs text-slate-400">Sin productos.</span>}
            </div>
          </div>
        </details>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
        <KPI label="Total vendido" value={`$${fmt(g.total)}`} color="text-emerald-700" />
        <KPI label="Subtotal" value={`$${fmt(g.subtotal)}`} />
        <KPI label="IVA" value={`$${fmt(g.tax)}`} />
        <KPI label="Descuentos" value={`$${fmt(g.discount)}`} color="text-amber-600" />
        <KPI label="Documentos" value={data?.documentCount || 0} sub={`${g.count || 0} completados`} />
        <KPI label="Anulados" value={v.count || 0} sub={`$${fmt(v.total)}`} color="text-rose-600" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Ventas en el tiempo */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Ventas en el período</h3>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data?.timeSeries || []}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip formatter={(val) => `$${fmt(val)}`} />
              <Line type="monotone" dataKey="total" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Resumen de cobros */}
        <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Resumen de cobros (cómo se cobró)</h3>
          <ResponsiveContainer width="100%" height={260}>
            <PieChart>
              <Pie data={collectionsData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={90} label={(e) => `${e.name}: $${fmt(e.value)}`}>
                {collectionsData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <Tooltip formatter={(val) => `$${fmt(val)}`} />
              <Legend />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top servicios */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
        <h3 className="text-sm font-semibold text-slate-700 mb-2">Ventas por servicio (top 12)</h3>
        <ResponsiveContainer width="100%" height={320}>
          <BarChart data={topServices} layout="vertical" margin={{ left: 40 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis type="number" tick={{ fontSize: 11 }} />
            <YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10 }} />
            <Tooltip formatter={(val) => `$${fmt(val)}`} />
            <Bar dataKey="total" fill="#10b981" radius={[0, 4, 4, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Tabla detalle por servicio */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-x-auto">
        <table className="tbl">
          <thead className="bg-emerald-50 text-xs uppercase"><tr>
            <th className="px-3 py-2 text-left">Servicio</th><th className="px-3 py-2 text-left">Código</th>
            <th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 text-right">Descuento</th><th className="px-3 py-2 text-right">Total</th>
          </tr></thead>
          <tbody>
            {(data?.byService || []).map((s) => (
              <tr key={s._id} className="border-t">
                <td className="px-3 py-2">{s.name || '—'}</td>
                <td className="px-3 py-2 text-xs font-mono">{s.code}</td>
                <td className="px-3 py-2 text-right">{s.quantity}</td>
                <td className="px-3 py-2 text-right font-mono text-amber-600">{fmt(s.discount)}</td>
                <td className="px-3 py-2 text-right font-mono font-semibold">${fmt(s.total)}</td>
              </tr>
            ))}
            {!(data?.byService || []).length && <tr><td colSpan={5} className="px-3 py-8 text-center text-slate-400">Sin datos en el período</td></tr>}
          </tbody>
        </table>
      </div>

      {/* Modal categorías */}
      <Modal isOpen={showCat} onClose={() => setShowCat(false)} title={editCatId ? 'Editar categoría' : 'Categorías de servicios'} size="xl">
        {!editCatId && (
          <div className="mb-4">
            <div className="flex justify-between items-center mb-2"><p className="text-sm font-semibold">Categorías guardadas</p><button onClick={openNewCat} className="text-emerald-600 text-sm flex items-center gap-1"><HiOutlinePlus /> Nueva</button></div>
            <div className="space-y-1">
              {categories.map((c) => (
                <div key={c._id} className="flex items-center justify-between border rounded-lg px-3 py-2">
                  <div><span className="font-medium text-sm">{c.name}</span> <span className="text-xs text-slate-400">({(c.products || []).length} servicios)</span></div>
                  <div className="flex gap-2"><button onClick={() => openEditCat(c)} className="text-sky-600"><HiOutlinePencilSquare className="w-5 h-5" /></button><button onClick={() => delCat(c)} className="text-rose-500"><HiOutlineTrash className="w-5 h-5" /></button></div>
                </div>
              ))}
              {!categories.length && <p className="text-xs text-slate-400">No hay categorías. Crea una para agrupar servicios.</p>}
            </div>
          </div>
        )}
        <form onSubmit={saveCat} className="space-y-3 border-t pt-3">
          <p className="text-sm font-semibold">{editCatId ? 'Editar' : 'Nueva'} categoría</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Nombre" required><input required placeholder="Ej: Tratamientos faciales" value={catForm.name} onChange={(e) => setCatForm({ ...catForm, name: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" /></Field>
            <Field label="Descripción"><input placeholder="Opcional" value={catForm.description} onChange={(e) => setCatForm({ ...catForm, description: e.target.value })} className="w-full border border-slate-200 rounded-xl px-3.5 py-2.5 text-sm" /></Field>
          </div>
          <div>
            <p className="text-xs text-slate-500 mb-1">Productos/servicios incluidos ({catForm.products.length})</p>
            <input
              value={catProdSearch}
              onChange={(e) => setCatProdSearch(e.target.value)}
              placeholder="Buscar producto o servicio..."
              className="w-full border border-slate-200 rounded-xl px-3 py-2 text-xs mb-1"
            />
            <div className="max-h-48 overflow-y-auto grid grid-cols-2 md:grid-cols-3 gap-1 border rounded-lg p-2">
              {products
                .filter((p) => {
                  const q = catProdSearch.trim().toLowerCase();
                  if (!q) return true;
                  return p.name?.toLowerCase().includes(q) || p.code?.toLowerCase().includes(q);
                })
                .map((p) => (
                  <label key={p._id} className="flex items-center gap-1.5 text-xs">
                    <input type="checkbox" checked={catForm.products.includes(p._id)} onChange={() => toggleCatProduct(p._id)} />
                    <span className="truncate" title={p.name}>{p.name}</span>
                  </label>
                ))}
            </div>
          </div>
          <div className="flex justify-end gap-2">
            {editCatId && <button type="button" onClick={() => { setEditCatId(null); setCatForm({ name: '', description: '', products: [] }); }} className="px-4 py-2 bg-slate-200 rounded-xl text-sm">Nueva</button>}
            <button className="px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 text-sm">Guardar categoría</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
