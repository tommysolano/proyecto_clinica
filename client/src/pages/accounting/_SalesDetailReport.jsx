import { useEffect, useState, useCallback, Fragment } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import {
  HiOutlineArrowDownTray, HiOutlineChevronDown, HiOutlineChevronRight, HiOutlineBookmark,
  HiOutlinePlus, HiOutlineTrash, HiOutlineDocumentDuplicate, HiOutlineExclamationTriangle,
  HiOutlineDocumentText, HiOutlineArrowTopRightOnSquare,
} from 'react-icons/hi2';
import Modal from '../../components/Modal';
import Field from '../../components/Field';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import { fmt, fmtDate } from './_utils';

/**
 * REPORTE DE VENTAS CONCILIABLE.
 *
 * Todo lo que se ve lo calcula `services/salesReportService` en el backend: documentos, líneas,
 * pagos y resumen. La pantalla NO recalcula totales, así que el Excel (mismo servicio, mismos
 * filtros) no puede discrepar.
 *
 * La regla que hacía mentir al reporte anterior: agrupaba por `Sale.paymentMethod` (un RESUMEN),
 * y una venta de 100 pagada 40 en efectivo + 60 con tarjeta salía como «100 en mixto». Aquí cada
 * método suma lo suyo, y la parte a crédito NO es un cobro: es CxC.
 */

const METODOS = [
  ['efectivo', 'Efectivo'],
  ['transferencia', 'Transferencia'],
  ['deposito', 'Depósito'],
  ['tarjeta_debito', 'Tarjeta débito'],
  ['tarjeta_credito', 'Tarjeta crédito'],
  ['tarjeta_sin_tipo', 'Tarjeta (sin tipo)'],
  ['cheque', 'Cheque'],
  ['otro', 'Otros'],
];

const ORIGEN_PAGO = {
  VENTA: 'Pago inicial',
  COBRO_CXC: 'Cobro posterior (CxC)',
};

export default function SalesDetailReport({ rango, categories, products }) {
  const [presets, setPresets] = useState([]);
  const [filters, setFilters] = useState({
    preset: '', method: '', client: '', status: '', costCenter: '', categories: [], products: [],
  });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [abierta, setAbierta] = useState({});
  const [entry, setEntry] = useState(null);
  const [editor, setEditor] = useState(null);   // preset en edición
  const [costCenters, setCostCenters] = useState([]);

  const cargarPresets = useCallback(async () => {
    try { const r = await api.get('/sales-reports/presets'); setPresets(r.data || []); }
    catch { /* sin permiso: la pantalla sigue funcionando sin presets */ }
  }, []);
  useEffect(() => { cargarPresets(); }, [cargarPresets]);
  useEffect(() => {
    api.get('/cost-centers', { params: { active: true } })
      .then((r) => setCostCenters(r.data || []))
      .catch(() => setCostCenters([]));
  }, []);

  const params = useCallback(() => ({
    startDate: rango.startDate,
    endDate: rango.endDate,
    preset: filters.preset || undefined,
    method: filters.method || undefined,
    client: filters.client || undefined,
    status: filters.status || undefined,
    // Centro de costo REAL de la venta (el que se resolvió contra su bodega al registrarla).
    costCenter: filters.costCenter || undefined,
    categories: filters.categories.length ? filters.categories.join(',') : undefined,
    products: filters.products.length ? filters.products.join(',') : undefined,
  }), [rango, filters]);

  const consultar = async () => {
    setLoading(true);
    try {
      const r = await api.get('/sales-reports/report', { params: params() });
      setData(r.data);
    } catch (e) {
      toast.error(e.response?.data?.message || 'Error al generar el reporte');
    } finally { setLoading(false); }
  };

  /** El Excel usa EXACTAMENTE los mismos filtros y el mismo servicio: no se rehace aquí. */
  const exportar = async () => {
    try {
      const r = await api.get('/sales-reports/report.xlsx', { params: params(), responseType: 'blob' });
      const u = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = u; a.download = `reporte_ventas_${rango.startDate}_${rango.endDate}.xlsx`; a.click();
      URL.revokeObjectURL(u);
    } catch (e) {
      toast.error(e.response?.status === 403 ? 'No tienes permiso para exportar' : 'Error al exportar');
    }
  };

  /** Al aplicar un preset se restaura la consulta guardada (no se recalcula la categoría). */
  const aplicarPreset = (id) => {
    setFilters((f) => ({ ...f, preset: id }));
    const p = presets.find((x) => String(x._id) === String(id));
    if (p?.filters) {
      setFilters((f) => ({
        ...f,
        preset: id,
        method: p.filters.method || '',
        client: p.filters.client || '',
        status: p.filters.status || '',
        costCenter: p.filters.costCenter || '',
      }));
    }
  };

  const eliminarPreset = async (p) => {
    if (!window.confirm(`¿Eliminar el preset "${p.name}"?`)) return;
    try {
      await api.delete(`/sales-reports/presets/${p._id}`);
      if (filters.preset === String(p._id)) setFilters((f) => ({ ...f, preset: '' }));
      cargarPresets();
      toast.success('Preset eliminado');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const duplicarPreset = async (p) => {
    try {
      await api.post(`/sales-reports/presets/${p._id}/duplicate`);
      cargarPresets();
      toast.success('Preset duplicado');
    } catch (e) { toast.error(e.response?.data?.message || 'Error'); }
  };

  const inconsistentes = data ? data.documentos.filter((d) => !d.cuadra || d.detalleCuadra === false) : [];

  return (
    <div className="space-y-4">
      {/* Filtros + presets */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 p-3 grid grid-cols-1 md:grid-cols-7 gap-2">
        <Field label="Preset (consulta guardada)" className="md:col-span-2">
          <div className="flex gap-1">
            <select value={filters.preset} onChange={(e) => aplicarPreset(e.target.value)}
              className="w-full border border-slate-200 rounded-lg px-3 py-2">
              <option value="">— sin preset —</option>
              {presets.map((p) => <option key={p._id} value={p._id}>{p.name}</option>)}
            </select>
            <button onClick={() => setEditor({ name: '', description: '', includeCategories: [], includeProducts: [], excludeProducts: [] })}
              title="Nuevo preset"
              className="px-2 bg-emerald-50 text-emerald-700 rounded-lg border-none cursor-pointer">
              <HiOutlinePlus className="w-4 h-4" />
            </button>
          </div>
        </Field>
        <Field label="Método de pago">
          <select value={filters.method} onChange={(e) => setFilters({ ...filters, method: e.target.value })}
            className="w-full border border-slate-200 rounded-lg px-3 py-2">
            <option value="">Todos</option>
            {METODOS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            <option value="credito">Crédito (CxC)</option>
          </select>
        </Field>
        <Field label="Estado">
          <select value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })}
            className="w-full border border-slate-200 rounded-lg px-3 py-2">
            <option value="">Todos</option>
            <option value="completada">Completadas</option>
            <option value="anulada">Anuladas</option>
          </select>
        </Field>
        <Field label="Centro de costo">
          <select value={filters.costCenter} onChange={(e) => setFilters({ ...filters, costCenter: e.target.value })}
            className="w-full border border-slate-200 rounded-lg px-3 py-2">
            <option value="">Todos</option>
            {costCenters.map((c) => <option key={c._id} value={c._id}>{c.code} - {c.name}</option>)}
          </select>
        </Field>
        <Field label="Cliente">
          <input value={filters.client} onChange={(e) => setFilters({ ...filters, client: e.target.value })}
            placeholder="Buscar…" className="w-full border border-slate-200 rounded-lg px-3 py-2" />
        </Field>
        <div className="flex items-end gap-2">
          <button onClick={consultar} disabled={loading}
            className="flex-1 px-4 py-2 bg-emerald-600 text-white rounded-xl disabled:opacity-50">
            {loading ? 'Consultando…' : 'Consultar'}
          </button>
          {data && (
            <button onClick={exportar} title="Excel (mismos filtros)"
              className="px-3 py-2 bg-slate-700 text-white rounded-xl">
              <HiOutlineArrowDownTray className="w-4 h-4" />
            </button>
          )}
        </div>

        {/* Acciones del preset seleccionado */}
        {filters.preset && (
          <div className="md:col-span-6 flex items-center gap-2 text-xs text-slate-600">
            <HiOutlineBookmark className="w-4 h-4 text-emerald-600" />
            <span>Preset aplicado: <b>{presets.find((p) => String(p._id) === filters.preset)?.name}</b></span>
            <button onClick={() => setEditor(presets.find((p) => String(p._id) === filters.preset))}
              className="text-blue-600 bg-transparent border-none cursor-pointer">Editar</button>
            <button onClick={() => duplicarPreset(presets.find((p) => String(p._id) === filters.preset))}
              className="text-slate-600 bg-transparent border-none cursor-pointer flex items-center gap-0.5">
              <HiOutlineDocumentDuplicate className="w-3.5 h-3.5" /> Duplicar
            </button>
            <button onClick={() => eliminarPreset(presets.find((p) => String(p._id) === filters.preset))}
              className="text-rose-600 bg-transparent border-none cursor-pointer flex items-center gap-0.5">
              <HiOutlineTrash className="w-3.5 h-3.5" /> Eliminar
            </button>
          </div>
        )}
      </div>

      {data && (
        <>
          {/* Alertas de conciliación: una venta que no cuadra se VE, no se esconde. */}
          {data.alertas.map((a, i) => (
            <div key={i} className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2 flex items-center gap-2">
              <HiOutlineExclamationTriangle className="w-4 h-4 shrink-0" /> {a.mensaje}
            </div>
          ))}

          {/* Resumen */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
            <Stat title="Subtotal 0%" value={fmt(data.resumen.subtotal0)} />
            <Stat title="Subtotal gravado" value={fmt(data.resumen.subtotalGravado)} />
            <Stat title="Descuento" value={fmt(data.resumen.descuento)} />
            <Stat title="IVA" value={fmt(data.resumen.iva)} />
            <Stat title="Total" value={fmt(data.resumen.total)} color="text-slate-900" />
            <Stat title="Cobrado" value={fmt(data.resumen.cobrado)} color="text-emerald-700" />
            <Stat title="Pendiente (CxC)" value={fmt(data.resumen.pendiente)} color="text-amber-700" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2">
            {METODOS.map(([k, l]) => (
              <Stat key={k} small title={l} value={fmt(data.resumen.porMetodo[k] || 0)}
                color={k === 'tarjeta_sin_tipo' && data.resumen.porMetodo[k] > 0 ? 'text-amber-700' : 'text-slate-700'} />
            ))}
          </div>

          {/* Tabla de documentos */}
          <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 overflow-hidden">
            <div className="px-4 py-2 flex items-center justify-between text-xs text-slate-500 border-b border-slate-100">
              <span>{data.documentos.length} documento(s) · {data.resumen.anuladas} anulada(s)</span>
              {inconsistentes.length > 0 && (
                <span className="font-semibold text-rose-700">
                  {inconsistentes.length} documento(s) no concilian
                </span>
              )}
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-emerald-50 text-[10px] uppercase text-slate-600">
                  <tr>
                    <th className="w-8" />
                    <th className="px-2 py-2 text-left">Fecha</th>
                    <th className="px-2 py-2 text-left">Venta</th>
                    <th className="px-2 py-2 text-left">Factura</th>
                    <th className="px-2 py-2 text-left">Cliente</th>
                    <th className="px-2 py-2 text-left">Identificación</th>
                    <th className="px-2 py-2 text-left">Centro de costo</th>
                    <th className="px-2 py-2 text-right">Subtotal</th>
                    <th className="px-2 py-2 text-right">Desc.</th>
                    <th className="px-2 py-2 text-right">IVA</th>
                    <th className="px-2 py-2 text-right">Total</th>
                    <th className="px-2 py-2 text-right">Cobrado</th>
                    <th className="px-2 py-2 text-right">Saldo</th>
                    <th className="px-2 py-2 text-left">Estado</th>
                    <th className="px-2 py-2 text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {data.documentos.map((d) => {
                    const open = !!abierta[d.id];
                    const lineas = data.detalle.filter((l) => l.ventaId === d.id);
                    const pagos = data.pagos.filter((p) => p.ventaId === d.id);
                    const malo = !d.cuadra || d.detalleCuadra === false;
                    return (
                      <Fragment key={d.id}>
                        <tr className={`border-t border-slate-100 ${d.anulada ? 'opacity-60' : ''} ${malo ? 'bg-rose-50/50' : ''}`}>
                          <td className="px-2 py-2 text-center">
                            <button onClick={() => setAbierta({ ...abierta, [d.id]: !open })}
                              className="text-slate-500 bg-transparent border-none cursor-pointer">
                              {open ? <HiOutlineChevronDown /> : <HiOutlineChevronRight />}
                            </button>
                          </td>
                          <td className="px-2 py-2">{fmtDate(d.date)}</td>
                          <td className="px-2 py-2 font-mono">{d.numero}</td>
                          <td className="px-2 py-2 font-mono">{d.factura || '—'}</td>
                          <td className="px-2 py-2">{d.cliente}</td>
                          <td className="px-2 py-2">{d.identificacion || '—'}</td>
                          <td className="px-2 py-2 text-slate-600">{d.costCenterName || '—'}</td>
                          <td className="px-2 py-2 text-right font-mono">{fmt(d.subtotalGravado + d.subtotal0)}</td>
                          <td className="px-2 py-2 text-right font-mono">{fmt(d.descuento)}</td>
                          <td className="px-2 py-2 text-right font-mono">{fmt(d.iva)}</td>
                          <td className="px-2 py-2 text-right font-mono font-semibold">{fmt(d.total)}</td>
                          <td className="px-2 py-2 text-right font-mono text-emerald-700">{fmt(d.cobrado)}</td>
                          <td className="px-2 py-2 text-right font-mono text-amber-700">{fmt(d.saldo)}</td>
                          <td className="px-2 py-2">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                              d.anulada ? 'text-slate-600 bg-slate-100' : 'text-emerald-700 bg-emerald-50'
                            }`}>{d.estado.toUpperCase()}</span>
                            {d.legacy && (
                              <span className="ml-1 text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded"
                                title="Venta sin desglose de pagos: el método se dedujo del campo resumen">
                                LEGACY
                              </span>
                            )}
                            {malo && (
                              <span className="ml-1 text-[10px] font-bold text-rose-700 bg-rose-100 px-1.5 py-0.5 rounded"
                                title="Total ≠ cobrado + saldo, o las líneas no suman el total">
                                NO CONCILIA
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            <div className="flex items-center gap-1 justify-end">
                              <button onClick={() => window.open(`/sales?doc=${d.id}`, '_blank')} title="Abrir venta"
                                className="p-1 rounded hover:bg-slate-100 text-slate-500 bg-transparent border-none cursor-pointer">
                                <HiOutlineArrowTopRightOnSquare className="w-4 h-4" />
                              </button>
                              {d.facturaId && (
                                <button onClick={() => window.open(`/invoices?doc=${d.facturaId}`, '_blank')} title="Abrir factura"
                                  className="px-1.5 py-0.5 rounded text-[10px] font-semibold border border-slate-200 text-slate-600 bg-white cursor-pointer">
                                  F
                                </button>
                              )}
                              {d.journalEntry && (
                                <button onClick={() => setEntry(d.journalEntry)} title="Ver asiento"
                                  className="p-1 rounded hover:bg-slate-100 text-slate-500 bg-transparent border-none cursor-pointer">
                                  <HiOutlineDocumentText className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>

                        {open && (
                          <tr className="bg-slate-50/70">
                            <td />
                            <td colSpan={14} className="px-3 py-3 space-y-3">
                              {/* Detalle: la suma de las líneas es el total del documento */}
                              <div>
                                <p className="text-[11px] font-semibold text-slate-600 mb-1">Detalle</p>
                                <table className="min-w-full text-[11px]">
                                  <thead className="text-slate-500">
                                    <tr>
                                      <th className="px-2 py-1 text-left">Categoría</th>
                                      <th className="px-2 py-1 text-left">Producto / servicio</th>
                                      <th className="px-2 py-1 text-right">Cant.</th>
                                      <th className="px-2 py-1 text-right">Precio</th>
                                      <th className="px-2 py-1 text-right">Descuento</th>
                                      <th className="px-2 py-1 text-right">Subtotal</th>
                                      <th className="px-2 py-1 text-right">IVA</th>
                                      <th className="px-2 py-1 text-right">Total línea</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {lineas.map((l, i) => (
                                      <tr key={i} className="border-t border-slate-200">
                                        <td className="px-2 py-1">{l.categoria || '(sin categoría)'}</td>
                                        <td className="px-2 py-1">{l.producto}</td>
                                        <td className="px-2 py-1 text-right font-mono">{l.cantidad}</td>
                                        <td className="px-2 py-1 text-right font-mono">{fmt(l.precio)}</td>
                                        <td className="px-2 py-1 text-right font-mono">{fmt(l.descuento)}</td>
                                        <td className="px-2 py-1 text-right font-mono">{fmt(l.subtotal)}</td>
                                        <td className="px-2 py-1 text-right font-mono">{fmt(l.iva)}</td>
                                        <td className="px-2 py-1 text-right font-mono font-semibold">{fmt(l.totalLinea)}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                  <tfoot>
                                    <tr className="border-t border-slate-300 font-semibold">
                                      <td className="px-2 py-1" colSpan={7}>Suma de líneas</td>
                                      <td className={`px-2 py-1 text-right font-mono ${d.detalleCuadra === false ? 'text-rose-700' : ''}`}>
                                        {fmt(d.sumaLineas)} {d.detalleCuadra === false && '≠ total'}
                                      </td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>

                              {/* Pagos: la parte a crédito NO aparece aquí (es CxC) */}
                              <div>
                                <p className="text-[11px] font-semibold text-slate-600 mb-1">
                                  Pagos reales · el saldo a crédito no es un pago: es CxC
                                </p>
                                <table className="min-w-full text-[11px]">
                                  <thead className="text-slate-500">
                                    <tr>
                                      <th className="px-2 py-1 text-left">Fecha</th>
                                      <th className="px-2 py-1 text-left">Método</th>
                                      <th className="px-2 py-1 text-left">Tipo de tarjeta</th>
                                      <th className="px-2 py-1 text-left">Referencia</th>
                                      <th className="px-2 py-1 text-left">Origen</th>
                                      <th className="px-2 py-1 text-right">Importe</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {pagos.map((p, i) => (
                                      <tr key={i} className="border-t border-slate-200">
                                        <td className="px-2 py-1">{p.date ? fmtDate(p.date) : '—'}</td>
                                        <td className="px-2 py-1">
                                          {METODOS.find(([k]) => k === p.method)?.[1] || p.method}
                                        </td>
                                        <td className="px-2 py-1">
                                          {p.cardType || (p.method === 'tarjeta_sin_tipo'
                                            ? <span className="text-amber-700">sin evidencia</span> : '—')}
                                        </td>
                                        <td className="px-2 py-1">{p.referencia || '—'}</td>
                                        <td className="px-2 py-1">
                                          {p.legacy ? 'Fallback legacy' : (ORIGEN_PAGO[p.origen] || p.origen)}
                                        </td>
                                        <td className="px-2 py-1 text-right font-mono">{fmt(p.importe)}</td>
                                      </tr>
                                    ))}
                                    {!pagos.length && (
                                      <tr><td colSpan={6} className="px-2 py-2 text-slate-400">Sin pagos: la venta está a crédito.</td></tr>
                                    )}
                                  </tbody>
                                  <tfoot>
                                    <tr className="border-t border-slate-300 font-semibold">
                                      <td className="px-2 py-1" colSpan={5}>Cobrado + saldo CxC</td>
                                      <td className={`px-2 py-1 text-right font-mono ${!d.cuadra ? 'text-rose-700' : ''}`}>
                                        {fmt(d.cobrado)} + {fmt(d.saldo)} = {fmt(d.cobrado + d.saldo)}
                                        {!d.cuadra && ` ≠ ${fmt(d.total)}`}
                                      </td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                  {!data.documentos.length && (
                    <tr><td colSpan={15} className="px-2 py-8 text-center text-slate-400">Sin ventas en el rango</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {editor && (
        <PresetEditor
          preset={editor}
          categories={categories}
          products={products}
          onClose={() => setEditor(null)}
          onSaved={() => { setEditor(null); cargarPresets(); }}
        />
      )}

      <JournalEntryViewModal
        isOpen={!!entry}
        onClose={() => setEntry(null)}
        entryId={entry}
        title="Asiento de la venta"
      />
    </div>
  );
}

function Stat({ title, value, color = 'text-slate-800', small }) {
  return (
    <div className="bg-white rounded-xl shadow-sm p-2.5">
      <p className="text-[10px] text-slate-500">{title}</p>
      <p className={`${small ? 'text-sm' : 'text-base'} font-bold font-mono ${color}`}>{value}</p>
    </div>
  );
}

/**
 * Editor de presets. Una categoría CARGA sus productos, pero lo que se guarda es la selección
 * EXACTA (inclusiones y exclusiones): al abrir el preset se restaura eso, no lo que la categoría
 * contenga ese día.
 */
function PresetEditor({ preset, categories, products, onClose, onSaved }) {
  const [f, setF] = useState({
    name: preset.name || '',
    description: preset.description || '',
    includeCategories: (preset.includeCategories || []).map((c) => String(c._id || c)),
    includeProducts: (preset.includeProducts || []).map(String),
    excludeProducts: (preset.excludeProducts || []).map(String),
    filters: preset.filters || {},
  });
  const [busy, setBusy] = useState(false);

  // Productos que aportan las categorías elegidas.
  const deCategorias = new Set();
  for (const c of categories) {
    if (!f.includeCategories.includes(String(c._id))) continue;
    for (const p of c.products || []) deCategorias.add(String(p._id || p));
  }
  const seleccionados = new Set([...deCategorias, ...f.includeProducts]);
  for (const x of f.excludeProducts) seleccionados.delete(x);

  const toggleProducto = (id) => {
    const s = String(id);
    if (deCategorias.has(s)) {
      // Viene de una categoría: desmarcarlo es EXCLUIRLO.
      setF((x) => ({
        ...x,
        excludeProducts: x.excludeProducts.includes(s)
          ? x.excludeProducts.filter((y) => y !== s)
          : [...x.excludeProducts, s],
      }));
    } else {
      // No viene de ninguna categoría: marcarlo es INCLUIRLO por fuera.
      setF((x) => ({
        ...x,
        includeProducts: x.includeProducts.includes(s)
          ? x.includeProducts.filter((y) => y !== s)
          : [...x.includeProducts, s],
      }));
    }
  };

  const guardar = async () => {
    if (!f.name.trim()) { toast.error('El preset necesita un nombre'); return; }
    setBusy(true);
    try {
      if (preset._id) await api.put(`/sales-reports/presets/${preset._id}`, f);
      else await api.post('/sales-reports/presets', f);
      toast.success('Preset guardado');
      onSaved();
    } catch (e) {
      // 409 controlado: nunca un E11000.
      toast.error(e.response?.data?.message || 'Error');
    } finally { setBusy(false); }
  };

  return (
    <Modal isOpen onClose={onClose} size="lg" title={preset._id ? 'Editar preset' : 'Nuevo preset'}>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Nombre" required>
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </Field>
          <Field label="Descripción">
            <input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })}
              className="w-full border border-slate-200 rounded-xl px-3 py-2" />
          </Field>
        </div>

        <Field label="Categorías comerciales">
          <div className="border border-slate-200 rounded-xl p-2 max-h-28 overflow-y-auto space-y-1">
            {categories.map((c) => (
              <label key={c._id} className="flex items-center gap-2 text-xs">
                <input type="checkbox" checked={f.includeCategories.includes(String(c._id))}
                  onChange={() => setF((x) => ({
                    ...x,
                    includeCategories: x.includeCategories.includes(String(c._id))
                      ? x.includeCategories.filter((y) => y !== String(c._id))
                      : [...x.includeCategories, String(c._id)],
                  }))} />
                {c.name} <span className="text-slate-400">({(c.products || []).length})</span>
              </label>
            ))}
            {!categories.length && <p className="text-xs text-slate-400">No hay categorías de servicios.</p>}
          </div>
        </Field>

        <Field label={`Ítems incluidos (${seleccionados.size})`}>
          <div className="border border-slate-200 rounded-xl p-2 max-h-40 overflow-y-auto space-y-1">
            {products.map((p) => {
              const s = String(p._id);
              const marcado = seleccionados.has(s);
              const porCategoria = deCategorias.has(s);
              return (
                <label key={s} className="flex items-center gap-2 text-xs">
                  <input type="checkbox" checked={marcado} onChange={() => toggleProducto(s)} />
                  <span className={marcado ? '' : 'text-slate-400'}>{p.code} — {p.name}</span>
                  {porCategoria && !marcado && (
                    <span className="text-[10px] font-bold text-rose-600 bg-rose-50 px-1 rounded">EXCLUIDO</span>
                  )}
                  {!porCategoria && marcado && (
                    <span className="text-[10px] font-bold text-sky-700 bg-sky-50 px-1 rounded">AÑADIDO</span>
                  )}
                </label>
              );
            })}
          </div>
          <p className="text-[11px] text-slate-500 mt-1">
            Desmarcar un ítem de la categoría lo <b>excluye</b>; marcar uno de fuera lo <b>añade</b>.
            Se guarda la selección exacta: si mañana cambia la categoría, el preset no cambia.
          </p>
        </Field>

        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl border border-slate-200 text-slate-600">Cancelar</button>
          <button onClick={guardar} disabled={busy} className="px-4 py-2 rounded-xl bg-emerald-600 text-white disabled:opacity-50">
            {busy ? 'Guardando…' : 'Guardar preset'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
