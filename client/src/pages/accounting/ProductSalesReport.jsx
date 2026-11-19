import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { HiOutlineChartBar, HiOutlineChevronDown, HiOutlineChevronRight, HiOutlineMagnifyingGlass, HiOutlinePrinter, HiOutlineArrowDownTray } from 'react-icons/hi2';
import { LineChart, Line, PieChart, Pie, Cell, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';
import api from '../../api/axios';
import { useAuth } from '../../context/AuthContext';
import DateInput from '../../components/DateInput';
import ProductSelect from '../../components/ProductSelect';
import { downloadFile } from '../../utils/download';
import { fmt, startOfMonth, endOfMonth } from './_utils';

/**
 * REPORTE DE VENTAS DE UN PRODUCTO (nov-2026), como el de Contífico. Se abre en una pestaña nueva
 * al hacer clic en un ítem de Bodegas → Existencias (?product=…&costCenter=…).
 *  - Resumen general y gráfico por producto/categoría/cliente: lo vendido DEL producto (sus líneas).
 *  - Resumen de cobros, documentos y gráfico por hora: los documentos completos que lo incluyen.
 */
const COLORS = ['#3366cc', '#dc3912', '#ff9900', '#109618', '#990099', '#0099c6', '#dd4477', '#66aa00', '#b82e2e', '#316395'];
const TIPOS_GRAFICO = [
  ['producto', 'Producto'],
  ['categoria', 'Categoría'],
  ['cliente', 'Cliente'],
  ['vendedor', 'Vendedor'],
  ['sucursal', 'Sucursal'],
];
const METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', anticipo: 'Anticipo', credito: 'Crédito', mixto: 'Mixto' };
const fechaHora = (d) => (d ? new Date(d).toLocaleString('es-EC', { timeZone: 'America/Guayaquil', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '');
const cant = (n) => Number(n || 0).toLocaleString('es-EC', { maximumFractionDigits: 4 });

/** Tabla de dos columnas (concepto · valor), como las de Contífico. */
function TablaResumen({ titulo, filas }) {
  return (
    <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
      <div className="bg-slate-100 px-3 py-2.5 text-sm font-semibold text-slate-700 border-b border-slate-200">{titulo}</div>
      <table className="w-full text-sm">
        <tbody>
          {filas.map(([label, valor, destacado]) => (
            <tr key={label} className={`border-t border-slate-100 first:border-t-0 ${destacado ? 'font-semibold bg-slate-50' : ''}`}>
              <td className="px-3 py-1.5 text-slate-700 border-r border-slate-100">{label}</td>
              <td className="px-3 py-1.5 text-right font-mono whitespace-nowrap">{valor}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function ProductSalesReport() {
  const [params, setParams] = useSearchParams();
  const { role, user } = useAuth();
  const puedeExportar = !!user?.isSuperAdmin || ['admin', 'contabilidad'].includes(role);

  const [filtros, setFiltros] = useState(() => ({
    startDate: params.get('startDate') || startOfMonth(),
    endDate: params.get('endDate') || endOfMonth(),
    product: params.get('product') || '',
    category: params.get('category') || '',
    costCenter: params.get('costCenter') || '',
    client: params.get('client') || '',
    chart: params.get('chart') || 'producto',
  }));
  const [abierto, setAbierto] = useState(true);
  const [products, setProducts] = useState([]);
  const [categorias, setCategorias] = useState([]);
  const [centros, setCentros] = useState([]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [verDocs, setVerDocs] = useState(50);

  useEffect(() => {
    api.get('/products', { params: { includeDisabled: 'true' } }).then((r) => setProducts(r.data || [])).catch(() => {});
    api.get('/inventory-advanced/categories', { params: { catalog: 'company' } }).then((r) => setCategorias(r.data || [])).catch(() => {});
    api.get('/cost-centers').then((r) => setCentros(r.data || [])).catch(() => {});
  }, []);

  const query = (f) => Object.fromEntries(Object.entries(f).filter(([, v]) => v !== '' && v != null));

  const consultar = async (f = filtros) => {
    setLoading(true);
    try {
      const r = await api.get('/sales-reports/product', { params: query(f) });
      setData(r.data);
      setVerDocs(50);
      setParams(query(f), { replace: true });
    } catch (e) {
      toast.error(e.response?.data?.message || 'No se pudo generar el reporte');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { consultar(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k, v) => setFiltros((f) => ({ ...f, [k]: v }));
  const titulo = useMemo(() => {
    const p = data?.filtros?.productos?.[0];
    if (p) return `${p.code ? `${p.code} - ` : ''}${p.name}`;
    if (data?.filtros?.categoria) return `Categoría ${data.filtros.categoria.name}`;
    return 'Todos los productos';
  }, [data]);

  const exportarExcel = () => downloadFile('/sales-reports/product.xlsx', { filename: 'reporte_ventas_producto.xlsx', params: query(filtros) })
    .catch((e) => toast.error(e?.message || 'No se pudo exportar'));

  const g = data?.general;
  const c = data?.cobros;
  const d = data?.documentos;
  const etiquetaGrafico = TIPOS_GRAFICO.find(([k]) => k === (data?.tipoGrafico || filtros.chart))?.[1] || 'Producto';
  const porHora = (data?.porHora || []).map((h) => ({ hora: `${String(h.hour).padStart(2, '0')}h`, total: h.total, documentos: h.count }));
  const totalGrafico = (data?.grafico || []).reduce((s, x) => s + x.total, 0);

  const campo = (label, control) => (
    <div className="grid grid-cols-1 sm:grid-cols-[140px_1fr] items-center gap-1 sm:gap-3">
      <label className="text-sm text-slate-600 sm:text-right">{label}</label>
      {control}
    </div>
  );
  const input = 'w-full border border-slate-200 rounded-lg px-3 py-2 text-sm bg-white';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
            <HiOutlineChartBar className="text-emerald-600" /> Reporte de Ventas
          </h1>
          <p className="text-sm text-slate-500 truncate">{titulo}{data?.filtros?.centro ? ` · ${data.filtros.centro.name}` : ''}</p>
        </div>
        <div className="flex gap-2 print:hidden">
          {puedeExportar && (
            <button type="button" onClick={exportarExcel} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 inline-flex items-center gap-1.5 cursor-pointer hover:bg-slate-50">
              <HiOutlineArrowDownTray className="w-4 h-4 text-emerald-600" /> Excel
            </button>
          )}
          <button type="button" onClick={() => window.print()} className="px-3 py-2 bg-white border border-slate-200 rounded-lg text-sm text-slate-700 inline-flex items-center gap-1.5 cursor-pointer hover:bg-slate-50">
            <HiOutlinePrinter className="w-4 h-4 text-sky-600" /> PDF
          </button>
        </div>
      </div>

      {/* Búsqueda */}
      <div className="bg-white rounded-xl border border-slate-200 print:hidden">
        <button type="button" onClick={() => setAbierto((v) => !v)} className="w-full flex items-center gap-2 px-4 py-3 bg-transparent border-none cursor-pointer text-left font-semibold text-slate-700 border-b border-slate-100">
          {abierto ? <HiOutlineChevronDown className="text-sky-600" /> : <HiOutlineChevronRight className="text-sky-600" />} Búsqueda
        </button>
        {abierto && (
          <form onSubmit={(e) => { e.preventDefault(); consultar(); }} className="p-4 space-y-3">
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-8 gap-y-3">
              {campo('Desde', <DateInput value={filtros.startDate} onChange={(e) => set('startDate', e.target.value)} className={input} />)}
              {campo('Hasta', <DateInput value={filtros.endDate} onChange={(e) => set('endDate', e.target.value)} className={input} />)}
              {campo('Categoría producto', (
                <select value={filtros.category} onChange={(e) => set('category', e.target.value)} className={input}>
                  <option value="">Todas</option>
                  {categorias.map((x) => <option key={x._id} value={x._id}>{x.name}</option>)}
                </select>
              ))}
              {campo('Producto', (
                <ProductSelect products={products} value={filtros.product} onChange={(v) => set('product', v || '')} allowClear placeholder="Todos los productos" showStock={false} />
              ))}
              {campo('Centro de costo', (
                <select value={filtros.costCenter} onChange={(e) => set('costCenter', e.target.value)} className={input}>
                  <option value="">Todos</option>
                  {centros.map((x) => <option key={x._id} value={x._id}>{x.code ? `${x.code} — ` : ''}{x.name}</option>)}
                </select>
              ))}
              {campo('Cliente', (
                <input value={filtros.client} onChange={(e) => set('client', e.target.value)} placeholder="Cédula/RUC o nombre" className={input} />
              ))}
              {campo('Tipo gráfico', (
                <select value={filtros.chart} onChange={(e) => set('chart', e.target.value)} className={input}>
                  {TIPOS_GRAFICO.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
              ))}
            </div>
            <button type="submit" disabled={loading} className="px-4 py-2 bg-sky-500 text-white rounded-lg border-none cursor-pointer inline-flex items-center gap-2 disabled:opacity-50 hover:bg-sky-600">
              <HiOutlineMagnifyingGlass className="w-4 h-4" /> {loading ? 'Consultando…' : 'Consultar'}
            </button>
          </form>
        )}
      </div>

      {!data ? (
        <div className="text-center text-slate-400 py-10">{loading ? 'Cargando…' : 'Sin datos'}</div>
      ) : (
        <>
          {/* Gráficos */}
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border border-slate-200 p-3 lg:col-span-2">
              <p className="text-sm font-semibold text-slate-700 mb-2">Por hora <span className="font-normal text-xs text-slate-400">(total de los documentos)</span></p>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={porHora} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                    <XAxis dataKey="hora" tick={{ fontSize: 10 }} interval={1} />
                    <YAxis tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v, n) => (n === 'total' ? [`$${fmt(v)}`, 'Total'] : [v, 'Documentos'])} />
                    <Line type="linear" dataKey="total" stroke="#3366cc" strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="bg-white rounded-xl border border-slate-200 p-3">
              <p className="text-sm font-semibold text-slate-700 mb-2">Por {etiquetaGrafico.toLowerCase()}</p>
              <div className="h-64">
                {data.grafico.length ? (
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={data.grafico} dataKey="total" nameKey="label" outerRadius="70%"
                        label={({ percent }) => `${(percent * 100).toFixed(0)}%`} labelLine={false}>
                        {data.grafico.map((x, i) => <Cell key={x.key} fill={COLORS[i % COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v) => [`$${fmt(v)} (${totalGrafico ? ((v / totalGrafico) * 100).toFixed(1) : 0}%)`, 'Total']} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                ) : <p className="text-center text-slate-400 text-sm pt-20">Sin ventas</p>}
              </div>
            </div>
          </div>

          {/* Resúmenes */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-start">
            <TablaResumen titulo="Resumen General" filas={[
              ['Cantidad vendida', cant(g.cantidad)],
              ['Subtotal 0', `$${fmt(g.subtotal0)}`],
              ['Subtotal IVA', `$${fmt(g.subtotalIva)}`],
              ['IVA', `$${fmt(g.iva)}`],
              ['Descuento', `$${fmt(g.descuento)}`],
              ['TOTAL', `$${fmt(g.total)}`, true],
              ['Notas de Crédito', `$${fmt(g.notasCredito)}`],
            ]} />
            <TablaResumen titulo="Resumen de Cobros" filas={[
              ['Efectivo', `$${fmt(c.efectivo)}`],
              ['Tarjeta', `$${fmt(c.tarjeta)}`],
              ['Transferencia', `$${fmt(c.transferencia)}`],
              ['Anticipos', `$${fmt(c.anticipo)}`],
              ['Otras formas de cobro', `$${fmt(c.otros)}`],
              ['Total', `$${fmt(c.total)}`, true],
              ['Pendiente de cobro (crédito)', `$${fmt(c.pendiente)}`],
              ['Cobrado', `$${fmt(c.cobrado)}`, true],
            ]} />
            <TablaResumen titulo="Cantidad Documentos" filas={[
              ['Cobrados', d.cobrados],
              ['Pendientes', d.pendientes],
              ['Anulados', d.anulados],
              ['Total', d.total, true],
              ['Promedio x Documento Emitido', `$${fmt(d.promedio)}`],
            ]} />
          </div>
          <p className="text-[11px] text-slate-400">
            El resumen general es lo vendido del producto. Los cobros y los documentos son de las ventas completas que lo incluyen
            (una venta que llevó también otras cosas suma completa), igual que en Contífico.
          </p>

          {/* Documentos */}
          <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100 text-sm font-semibold text-slate-700">Documentos ({data.detalle.length})</div>
            <div className="overflow-x-auto">
              <table className="tbl tbl-cards text-sm w-full">
                <thead className="bg-slate-50 text-xs uppercase text-slate-500"><tr>
                  <th className="px-3 py-2 text-left">Fecha</th>
                  <th className="px-3 py-2 text-left">Documento</th>
                  <th className="px-3 py-2 text-left">Cliente</th>
                  <th className="px-3 py-2 text-right">Cantidad</th>
                  <th className="px-3 py-2 text-right">Valor producto</th>
                  <th className="px-3 py-2 text-right">Total doc.</th>
                  <th className="px-3 py-2 text-left">Cobro</th>
                  <th className="px-3 py-2 text-left">Estado</th>
                </tr></thead>
                <tbody>
                  {data.detalle.length === 0 && <tr><td colSpan={8} className="px-3 py-6 text-center text-slate-400">No hay ventas con estos filtros</td></tr>}
                  {data.detalle.slice(0, verDocs).map((x) => (
                    <tr key={x._id} className={`border-t ${x.estado === 'anulada' ? 'opacity-60' : ''}`}>
                      <td data-cell="hora" className="px-3 py-1.5 whitespace-nowrap text-xs text-slate-500">{fechaHora(x.fecha)}</td>
                      <td data-cell="principal" className="px-3 py-1.5">
                        <span className="font-mono text-xs">{x.factura || x.venta}</span>
                        <span className="block text-[11px] text-slate-400">{x.factura ? x.venta : 'sin factura'}{x.sucursal ? ` · ${x.sucursal}` : ''}</span>
                      </td>
                      <td data-cell="detalle" className="px-3 py-1.5">
                        {x.cliente}{x.cedula && <span className="block text-[11px] text-slate-400 font-mono">{x.cedula}</span>}
                      </td>
                      <td data-cell="detalle" className="px-3 py-1.5 text-right font-mono">{cant(x.cantidad)}</td>
                      <td data-cell="detalle" className="px-3 py-1.5 text-right font-mono">${fmt(x.valorProducto)}</td>
                      <td data-cell="detalle" className="px-3 py-1.5 text-right font-mono">${fmt(x.totalDocumento)}</td>
                      <td data-cell="detalle" className="px-3 py-1.5 text-xs text-slate-600">
                        {x.pagos.map((p) => `${METODO[p.method] || p.method} $${fmt(p.amount)}`).join(' + ')}
                      </td>
                      <td data-cell="estado" className="px-3 py-1.5">
                        <span className={`px-2 py-0.5 rounded-full text-[11px] ${x.estado === 'anulada' ? 'bg-rose-100 text-rose-700' : 'bg-emerald-100 text-emerald-700'}`}>{x.estado}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.detalle.length > verDocs && (
              <div className="p-3 text-center print:hidden">
                <button type="button" onClick={() => setVerDocs((n) => n + 100)} className="px-4 py-1.5 bg-slate-100 rounded-lg text-sm border-none cursor-pointer">
                  Ver más ({data.detalle.length - verDocs} restantes)
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
