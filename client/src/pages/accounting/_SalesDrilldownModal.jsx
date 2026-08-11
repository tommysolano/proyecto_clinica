import { useEffect, useState } from 'react';
import api from '../../api/axios';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import ExcelButton from '../../components/ExcelButton';
import SourceDocLink from '../../components/SourceDocLink';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import { HiOutlineBookOpen } from 'react-icons/hi2';
import { fmt, fmtDate } from './_utils';

/**
 * DETALLE DE UNA FILA DE LOS REPORTES DE VENTAS.
 *
 * Los reportes gerenciales muestran totales agrupados ("producto X: $1.240"), y la
 * pregunta que sigue es siempre "¿de qué ventas salió eso?". Este modal abre esa fila:
 * una línea por venta (o por línea de venta, cuando se agrupa por producto/categoría),
 * cada una con su venta, su factura y su asiento, para poder revisar la contabilidad
 * sin salir del reporte.
 *
 * Props: { open, onClose, dimension, keyValue, name, label, rango, granularity }
 *   dimension  period | product | category | seller | cashier
 *   keyValue   la clave de la fila ('' = «sin asignar»)
 *   name       nombre del producto (afina cuando el reporte separó filas homónimas)
 */
export default function SalesDrilldownModal({ open, onClose, dimension, keyValue, name, label, rango, granularity }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [asiento, setAsiento] = useState(null);   // { model, ref } de la venta a inspeccionar

  const params = {
    dimension,
    key: keyValue ?? '',
    ...(name ? { name } : {}),
    ...(label ? { label } : {}),
    startDate: rango?.startDate,
    endDate: rango?.endDate,
    ...(dimension === 'period' ? { granularity } : {}),
  };

  useEffect(() => {
    if (!open || !dimension) return;
    let vivo = true;
    setLoading(true);
    setData(null);
    api.get('/accounting-reports/sales/drilldown', { params })
      .then((r) => { if (vivo) setData(r.data); })
      .catch((e) => toast.error(e.response?.data?.message || 'No se pudo cargar el detalle'))
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, dimension, keyValue, name, rango?.startDate, rango?.endDate, granularity]);

  const porLinea = data?.level === 'line';
  const t = data?.totals || {};
  const rows = data?.rows || [];

  return (
    <>
      <Modal isOpen={open} onClose={onClose} title={`Detalle — ${label || 'Sin asignar'}`} size="full">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3 text-sm">
            <span className="text-slate-500">
              {t.ventas || 0} venta{(t.ventas || 0) === 1 ? '' : 's'}
              {porLinea ? ` · ${t.lineas || 0} línea${(t.lineas || 0) === 1 ? '' : 's'}` : ''}
            </span>
            <span className="text-slate-500">Subtotal <b className="text-slate-800">${fmt(t.subtotal)}</b></span>
            <span className="text-slate-500">IVA <b className="text-slate-800">${fmt(t.iva)}</b></span>
            <span className="text-slate-500">Total <b className="text-emerald-700">${fmt(t.total)}</b></span>
            {porLinea && <span className="text-slate-500">Costo <b className="text-rose-600">${fmt(t.costo)}</b></span>}
            {porLinea && <span className="text-slate-500">Utilidad <b className="text-emerald-700">${fmt(t.utilidad)}</b></span>}
            <span className="flex-1" />
            {/* El mismo detalle en Excel: el respaldo del total que se está revisando. */}
            <ExcelButton
              url="/accounting-reports/sales/drilldown.xlsx"
              params={params}
              filename={`detalle_ventas_${dimension}.xlsx`}
              disabled={loading || !rows.length}
            />
          </div>

          {loading && <p className="text-center text-slate-500 py-8">Cargando detalle…</p>}

          {!loading && (
            <div className="overflow-x-auto border border-slate-100 rounded-xl">
              <table className="tbl text-sm">
                <thead className="bg-emerald-50 text-xs uppercase">
                  <tr>
                    <th className="px-3 py-2 text-left">Fecha</th>
                    <th className="px-3 py-2 text-left">Venta</th>
                    <th className="px-3 py-2 text-left">Cliente</th>
                    {porLinea && <th className="px-3 py-2 text-left">Producto / servicio</th>}
                    <th className="px-3 py-2 text-right">Cant.</th>
                    <th className="px-3 py-2 text-right">Subtotal</th>
                    <th className="px-3 py-2 text-right">IVA</th>
                    <th className="px-3 py-2 text-right">Total</th>
                    {porLinea && <th className="px-3 py-2 text-right">Costo</th>}
                    {porLinea && <th className="px-3 py-2 text-right">Utilidad</th>}
                    <th className="px-3 py-2 text-left">Factura</th>
                    <th className="px-3 py-2 text-center">Asiento</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={`${r.saleId}-${i}`} className="border-t border-slate-100 hover:bg-slate-50">
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(r.fecha)}</td>
                      {/* La venta y la factura abren su pantalla en el documento exacto. */}
                      <td className="px-3 py-2 font-mono text-xs">
                        <SourceDocLink model="Sale" id={r.saleId} number={r.venta} />
                      </td>
                      <td className="px-3 py-2">{r.cliente}</td>
                      {porLinea && <td className="px-3 py-2">{r.producto}</td>}
                      <td className="px-3 py-2 text-right font-mono">{r.cantidad}</td>
                      <td className="px-3 py-2 text-right font-mono">${fmt(r.subtotal)}</td>
                      <td className="px-3 py-2 text-right font-mono">${fmt(r.iva)}</td>
                      <td className="px-3 py-2 text-right font-mono font-semibold">${fmt(r.total)}</td>
                      {porLinea && <td className="px-3 py-2 text-right font-mono text-rose-600">${fmt(r.costo)}</td>}
                      {porLinea && <td className="px-3 py-2 text-right font-mono text-emerald-700">${fmt(r.utilidad)}</td>}
                      <td className="px-3 py-2 font-mono text-xs">
                        {r.invoiceId
                          ? <SourceDocLink model="Invoice" id={r.invoiceId} number={r.factura || 'Factura'} />
                          : <span className="text-slate-400">Sin facturar</span>}
                      </td>
                      <td className="px-3 py-2 text-center">
                        {/* Los asientos se piden por DOCUMENTO: una venta genera el de la
                            venta y el del costo, y el visor los trae los dos. */}
                        <button
                          onClick={() => setAsiento({ model: 'Sale', ref: String(r.saleId) })}
                          title="Ver el asiento contable de esta venta"
                          className="inline-flex items-center gap-1 text-sky-700 hover:underline"
                        >
                          <HiOutlineBookOpen className="w-4 h-4" /> Ver
                        </button>
                      </td>
                    </tr>
                  ))}
                  {!rows.length && (
                    <tr><td colSpan={porLinea ? 12 : 9} className="px-3 py-8 text-center text-slate-400">
                      No hay ventas en esta fila para el período elegido.
                    </td></tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Modal>

      <JournalEntryViewModal
        isOpen={!!asiento}
        onClose={() => setAsiento(null)}
        source={asiento}
        title="Asiento de la venta"
        emptyHint="La venta se contabiliza al facturarse o al cobrarse; si aún no tiene asiento, aparecerá cuando se contabilice."
      />
    </>
  );
}
