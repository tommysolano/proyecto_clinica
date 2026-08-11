import { useEffect, useState, useCallback } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import { HiOutlineArchiveBox, HiOutlineArrowDownTray, HiOutlineEye } from 'react-icons/hi2';
import Field from '../../components/Field';
import ProductSelect from '../../components/ProductSelect';
import InventoryMovementDetailModal from '../../components/InventoryMovementDetailModal';
import { fmt, fmtDate } from './_utils';
import { sourceLabel } from './sourceDocs';
import DateInput from '../../components/DateInput';

/**
 * KARDEX VALORIZADO. Todo lo que se ve aquí lo calcula `services/kardexService` en el backend:
 * el saldo inicial anterior al rango, el costo real (FIFO / el grabado en el movimiento) y los
 * saldos acumulados. La pantalla NO recalcula nada, así que no puede discrepar del Excel.
 *
 * Los IMPORTES solo llegan si el rol puede verlos: cuando no, el backend los omite y la API
 * devuelve `costsHidden`. Aquí simplemente no hay columnas de dinero que pintar.
 */

const TYPE_COLOR = { entrada: 'text-emerald-600', salida: 'text-rose-600', ajuste: 'text-amber-600', traslado: 'text-blue-600' };
const TYPE_LABEL = { entrada: 'Ingreso', salida: 'Egreso', ajuste: 'Ajuste', traslado: 'Traslado' };

export default function Kardex() {
  const [products, setProducts] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [filters, setFilters] = useState({
    product: '', warehouse: '', type: '', sourceModel: '', from: '', to: '', lot: '',
  });
  const [busqueda, setBusqueda] = useState('');   // código o código de barras
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [detalle, setDetalle] = useState(null);   // fila abierta en el hub de consulta

  useEffect(() => {
    api.get('/products').then((r) => setProducts(r.data?.items || r.data || [])).catch(() => {});
    api.get('/inventory-advanced/warehouses').then((r) => setWarehouses(r.data || [])).catch(() => {});
    api.get('/inventory-advanced/categories', { params: { kind: 'INVENTARIO' } })
      .then((r) => setCategories(r.data || [])).catch(() => {});
  }, []);

  const conCostos = data ? !data.costsHidden : true;

  /** Los filtros se envían al BACKEND (no se recorta un conjunto grande en el navegador). */
  const params = useCallback(() => Object.fromEntries(
    Object.entries(filters).filter(([, v]) => v)
  ), [filters]);

  const load = async () => {
    if (!filters.product) { toast.error('Elige un producto'); return; }
    setLoading(true);
    try {
      const r = await api.get('/inventory-advanced/kardex', { params: params() });
      setData(r.data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al generar el kardex');
    } finally { setLoading(false); }
  };

  /** El Excel usa EXACTAMENTE los mismos filtros y el mismo servicio (no se rehace aquí). */
  const exportar = async () => {
    try {
      const r = await api.get('/inventory-advanced/kardex.xlsx', { params: params(), responseType: 'blob' });
      const u = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = u; a.download = `kardex_${data?.producto?.code || ''}.xlsx`; a.click();
      URL.revokeObjectURL(u);
    } catch (e) {
      toast.error(e.response?.status === 403
        ? 'No tienes permiso para exportar el kardex'
        : 'Error al exportar');
    }
  };

  /** Busca el producto por código o código de barras y lo selecciona. */
  const buscarPorCodigo = () => {
    const q = busqueda.trim().toLowerCase();
    if (!q) return;
    const p = products.find((x) => String(x.code || '').toLowerCase() === q
      || String(x.barcode || '').toLowerCase() === q);
    if (!p) { toast.error('Ningún producto con ese código o código de barras'); return; }
    setFilters((f) => ({ ...f, product: p._id }));
  };

  const porBodega = !!filters.warehouse;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-2xl font-bold text-slate-800 tracking-tight flex items-center gap-2">
          <HiOutlineArchiveBox className="text-emerald-600" /> Kardex valorizado
        </h1>
        {data && (
          <button onClick={exportar} className="px-3 py-2 bg-slate-700 text-white rounded-xl text-sm flex items-center gap-1.5">
            <HiOutlineArrowDownTray className="w-4 h-4" /> Excel
          </button>
        )}
      </div>

      {/* Filtros */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-3 grid grid-cols-1 md:grid-cols-6 gap-2">
        <Field label="Producto" required className="md:col-span-2">
          <ProductSelect products={products} value={filters.product}
            onChange={(v) => setFilters({ ...filters, product: v })} allowClear />
        </Field>
        <Field label="Código o código de barras">
          <div className="flex gap-1">
            <input value={busqueda} onChange={(e) => setBusqueda(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && buscarPorCodigo()}
              placeholder="Escanear o escribir…"
              className="w-full px-3 py-2 border border-slate-200 rounded-lg" />
            <button onClick={buscarPorCodigo} className="px-2 bg-slate-100 rounded-lg text-slate-600 text-sm">Ir</button>
          </div>
        </Field>
        <Field label="Categoría de inventario">
          <select value={filters.category || ''} onChange={(e) => setFilters({ ...filters, category: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg">
            <option value="">Todas</option>
            {categories.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="Bodega">
          <select value={filters.warehouse} onChange={(e) => setFilters({ ...filters, warehouse: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg">
            <option value="">Consolidado (todas)</option>
            {warehouses.map((w) => <option key={w._id} value={w._id}>{w.code} — {w.name}</option>)}
          </select>
        </Field>
        <Field label="Tipo de movimiento">
          <select value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg">
            <option value="">Todos</option>
            <option value="entrada">Ingreso</option>
            <option value="salida">Egreso</option>
            <option value="ajuste">Ajuste</option>
            <option value="traslado">Traslado</option>
          </select>
        </Field>
        <Field label="Documento">
          <select value={filters.sourceModel} onChange={(e) => setFilters({ ...filters, sourceModel: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg">
            <option value="">Todos</option>
            <option value="PurchaseInvoice">Compra</option>
            <option value="Sale">Venta</option>
            <option value="PhysicalCount">Toma física</option>
            <option value="InventoryMovement">Traslado</option>
          </select>
        </Field>
        <Field label="Desde">
          <DateInput value={filters.from} onChange={(e) => setFilters({ ...filters, from: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg" />
        </Field>
        <Field label="Hasta">
          <DateInput value={filters.to} onChange={(e) => setFilters({ ...filters, to: e.target.value })}
            className="w-full px-3 py-2 border border-slate-200 rounded-lg" />
        </Field>
        <button onClick={load} disabled={loading}
          className="md:col-span-6 px-4 py-2 bg-emerald-600 text-white rounded-xl shadow-sm shadow-emerald-600/20 disabled:opacity-50">
          {loading ? 'Consultando…' : 'Consultar'}
        </button>
      </div>

      {data && (
        <>
          {/* Resumen: el rango NO empieza en cero */}
          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-4">
            <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
              <p className="font-semibold text-slate-800">
                {data.producto?.code} — {data.producto?.name}
                <span className="ml-2 text-xs font-normal text-slate-500">
                  {porBodega ? `Bodega ${data.bodega?.name}` : 'Consolidado (todas las bodegas)'}
                </span>
              </p>
              {!conCostos && (
                <span className="text-[11px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                  Tu rol no puede ver costos: se muestran solo cantidades.
                </span>
              )}
            </div>
            <div className={`grid grid-cols-2 ${conCostos ? 'md:grid-cols-5' : 'md:grid-cols-3'} gap-3`}>
              <Stat title="Saldo inicial (u)" value={data.saldoInicial.qty} />
              {conCostos && <Stat title="Saldo inicial ($)" value={fmt(data.saldoInicial.value)} />}
              <Stat title="Entradas (u)" value={data.totales.entradasQty} color="text-emerald-700"
                hint={conCostos ? fmt(data.totales.entradasValor) : null} />
              <Stat title="Salidas (u)" value={data.totales.salidasQty} color="text-rose-600"
                hint={conCostos ? fmt(data.totales.salidasValor) : null} />
              <Stat title="Saldo final (u)" value={data.saldoFinal.qty} />
              {conCostos && <Stat title="Saldo final ($)" value={fmt(data.saldoFinal.value)}
                hint={`Costo promedio ${fmt(data.saldoFinal.unitCost)}`} />}
            </div>
            {!data.totales.cuadra && (
              <p className="mt-2 text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1">
                El saldo final no cuadra con inicial + entradas − salidas. Revísalo con contabilidad.
              </p>
            )}
          </div>

          {/* Movimientos */}
          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-emerald-50 text-[10px] uppercase text-slate-600">
                  <tr>
                    <th className="px-2 py-2 text-left">Fecha</th>
                    <th className="px-2 py-2 text-left">Movimiento</th>
                    <th className="px-2 py-2 text-left">Documento</th>
                    <th className="px-2 py-2 text-left">Tercero / motivo</th>
                    <th className="px-2 py-2 text-left">Bodega origen</th>
                    <th className="px-2 py-2 text-left">Bodega destino</th>
                    <th className="px-2 py-2 text-right">Entrada</th>
                    <th className="px-2 py-2 text-right">Salida</th>
                    {conCostos && <th className="px-2 py-2 text-right">Costo unit.</th>}
                    {conCostos && <th className="px-2 py-2 text-right">Valor entrada</th>}
                    {conCostos && <th className="px-2 py-2 text-right">Valor salida</th>}
                    <th className="px-2 py-2 text-right">Saldo (u)</th>
                    {conCostos && <th className="px-2 py-2 text-right">Saldo ($)</th>}
                    <th className="px-2 py-2 text-left">Usuario</th>
                    <th className="px-2 py-2 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {/* El saldo inicial es una FILA: el kardex no arranca en cero. */}
                  <tr className="bg-slate-50 font-semibold border-t">
                    <td className="px-2 py-2" colSpan={6}>Saldo inicial (anterior al rango)</td>
                    <td className="px-2 py-2" />
                    <td className="px-2 py-2" />
                    {conCostos && <td colSpan={3} />}
                    <td className="px-2 py-2 text-right font-mono">{data.saldoInicial.qty}</td>
                    {conCostos && <td className="px-2 py-2 text-right font-mono">{fmt(data.saldoInicial.value)}</td>}
                    <td colSpan={2} />
                  </tr>

                  {data.rows.map((m) => (
                    <tr key={m.id} className={`border-t border-slate-100 ${m.esTraslado ? 'bg-blue-50/40' : ''}`}>
                      <td className="px-2 py-2 whitespace-nowrap">
                        {fmtDate(m.date)}
                        {/* Histórico sin fecha funcional: se dice, no se disimula. */}
                        {m.fechaEstimada && (
                          <span className="block text-[9px] font-bold text-amber-700" title="Movimiento histórico sin fecha de documento: se usa la fecha de grabación">
                            FECHA ESTIMADA
                          </span>
                        )}
                      </td>
                      <td className={`px-2 py-2 font-semibold ${TYPE_COLOR[m.type]}`}>
                        {TYPE_LABEL[m.type] || m.type}
                        {m.esTraslado && !porBodega && (
                          <span className="block text-[9px] font-bold text-blue-700 bg-blue-100 px-1 rounded"
                            title="Reubicación entre bodegas: no es compra ni venta, su efecto neto es cero">
                            INTERNO · NETO 0
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-2">{m.documento ? sourceLabel({ sourceModel: m.documento.model }) : '—'}</td>
                      <td className="px-2 py-2 text-slate-500">{m.tercero || m.motivo || '—'}</td>
                      <td className="px-2 py-2">{m.warehouse ? `${m.warehouse.code}` : '—'}</td>
                      <td className="px-2 py-2">{m.toWarehouse ? `${m.toWarehouse.code}` : '—'}</td>
                      <td className="px-2 py-2 text-right font-mono text-emerald-700">{m.entradaQty || ''}</td>
                      <td className="px-2 py-2 text-right font-mono text-rose-600">{m.salidaQty || ''}</td>
                      {conCostos && <td className="px-2 py-2 text-right font-mono">{fmt(m.unitCost)}</td>}
                      {conCostos && <td className="px-2 py-2 text-right font-mono text-emerald-700">{m.entradaValor ? fmt(m.entradaValor) : ''}</td>}
                      {conCostos && <td className="px-2 py-2 text-right font-mono text-rose-600">{m.salidaValor ? fmt(m.salidaValor) : ''}</td>}
                      <td className="px-2 py-2 text-right font-mono font-semibold">{m.saldoQty}</td>
                      {conCostos && <td className="px-2 py-2 text-right font-mono font-semibold">{fmt(m.saldoValor)}</td>}
                      <td className="px-2 py-2 text-slate-500">{m.usuario || '—'}</td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end">
                          <button onClick={() => setDetalle(m)}
                            title="Ver detalle: movimiento de inventario, asiento contable y factura (solo consulta)"
                            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100 cursor-pointer">
                            <HiOutlineEye className="w-4 h-4" /> Ver detalle
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}

                  {!data.rows.length && (
                    <tr><td colSpan={15} className="px-2 py-8 text-center text-slate-400">Sin movimientos en el rango</td></tr>
                  )}

                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-bold">
                    <td className="px-2 py-2" colSpan={6}>Saldo final</td>
                    <td className="px-2 py-2 text-right font-mono">{data.totales.entradasQty}</td>
                    <td className="px-2 py-2 text-right font-mono">{data.totales.salidasQty}</td>
                    {conCostos && (
                      <>
                        <td />
                        <td className="px-2 py-2 text-right font-mono">{fmt(data.totales.entradasValor)}</td>
                        <td className="px-2 py-2 text-right font-mono">{fmt(data.totales.salidasValor)}</td>
                      </>
                    )}
                    <td className="px-2 py-2 text-right font-mono">{data.saldoFinal.qty}</td>
                    {conCostos && <td className="px-2 py-2 text-right font-mono">{fmt(data.saldoFinal.value)}</td>}
                    <td colSpan={2} />
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <InventoryMovementDetailModal
        isOpen={!!detalle}
        onClose={() => setDetalle(null)}
        movement={detalle}
        producto={data?.producto}
        conCostos={conCostos}
      />
    </div>
  );
}

function Stat({ title, value, color = 'text-slate-800', hint }) {
  return (
    <div className="bg-slate-50 rounded-xl p-3">
      <p className="text-xs text-slate-500">{title}</p>
      <p className={`text-lg font-bold font-mono ${color}`}>{value}</p>
      {hint && <p className="text-[11px] text-slate-400 font-mono">{hint}</p>}
    </div>
  );
}
