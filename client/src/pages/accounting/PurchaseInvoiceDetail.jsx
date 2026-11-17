import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import api from '../../api/axios';
import JournalEntryViewModal from '../../components/JournalEntryViewModal';
import { HiOutlineBookOpen, HiOutlinePencilSquare, HiOutlineArrowLeft } from 'react-icons/hi2';
import { fmt, fmtDate, RET_ESTADO_LABEL, retVoucherNumber } from './_utils';
import { payStatus, PAY_METHOD_LABEL, DOC_TYPE_LABEL, CORREGIBLES, retencionEmitida } from './_purchaseLabels';

/**
 * DETALLE DE UNA COMPRA: toda la información de la factura en SOLO LECTURA, en su propia
 * página. Se abre en una pestaña nueva al hacer clic en el número de la compra.
 *
 * Antes la única forma de mirar el detalle era «Editar», que abre el formulario y, al
 * guardar, reversa y regenera el asiento: para consultar no hay que arriesgar eso. Sirve a
 * super admin, admin, contabilidad y asistente contable (los mismos que ven Compras).
 *
 * Pide el detalle con `?view=1` para recibir nombres (bodega, centro de costo, quién la
 * registró…) en vez de ids, y los abonos del endpoint de pagos (fuente única del saldo).
 * «Editar» lleva a Compras con `?doc=<id>`, que abre el formulario de esa factura.
 */
const LINE_TYPE_LABEL = { GASTO: 'Gasto', INVENTARIO: 'Inventario', ACTIVO_FIJO: 'Activo fijo' };
const PERIODO = (m, y) => (m && y ? `${String(m).padStart(2, '0')}/${y}` : '');
const cuenta = (a) => (a && typeof a === 'object' ? `${a.code || ''} ${a.name || ''}`.trim() : '');
const nombre = (x) => (x && typeof x === 'object' ? x.name || x.code || '' : '');
const fechaHora = (d) => (d ? `${fmtDate(d)} ${new Date(d).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Guayaquil' })}` : '');

function Dato({ label, children, mono = false, wide = false }) {
  if (children === null || children === undefined || children === '' || children === false) return null;
  return (
    <div className={wide ? 'col-span-2 sm:col-span-3' : ''}>
      <div className="text-[11px] uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`text-sm text-slate-800 break-words ${mono ? 'font-mono text-xs' : ''}`}>{children}</div>
    </div>
  );
}

function Seccion({ title, children }) {
  return (
    <section className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 sm:p-5 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-emerald-700">{title}</h3>
      {children}
    </section>
  );
}

export default function PurchaseInvoiceDetail() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [pagos, setPagos] = useState(null);
  const [error, setError] = useState('');
  const [verAsiento, setVerAsiento] = useState(false);

  useEffect(() => {
    let vivo = true;
    api.get(`/purchase-invoices/${id}`, { params: { view: 1 } })
      .then((r) => {
        if (!vivo) return;
        setData(r.data);
        document.title = `Compra ${r.data.serie || ''} · Vikingo`;
        // Los abonos solo existen en una compra contabilizada.
        if (r.data.status === 'REGISTRADA' || r.data.status === 'PAGADA') {
          api.get(`/purchase-invoices/${id}/payments`)
            .then((p) => { if (vivo) setPagos(p.data); })
            .catch(() => { if (vivo) setPagos({ rows: [] }); });
        }
      })
      .catch((e) => { if (vivo) setError(e.response?.data?.message || 'No se pudo cargar la factura'); });
    return () => { vivo = false; };
  }, [id]);

  const docTypeLabel = DOC_TYPE_LABEL;
  const payMethodLabel = PAY_METHOD_LABEL;
  const d = data || {};
  const s = d.supplier || {};
  const st = data ? payStatus(data) : {};
  const editable = data && CORREGIBLES.includes(data.status) && !retencionEmitida(data);
  const anulada = d.status === 'ANULADA';
  const items = d.items || [];
  const neto = +(Number(d.total || 0) - Number(d.retentionTotal || 0)).toFixed(2);
  const rv = d.retentionVoucher && typeof d.retentionVoucher === 'object' ? d.retentionVoucher : null;

  const subtotales = [
    ['Subtotal 15 %', d.subtotal15], ['Subtotal 5 %', d.subtotal5], ['Subtotal 12 %', d.subtotal12],
    ['Subtotal 0 %', d.subtotal0], ['No objeto de IVA', d.subtotalNoObjeto], ['Exento de IVA', d.subtotalExento],
  ].filter(([, v]) => Number(v) > 0.004);

  return (
    <div className="max-w-6xl mx-auto space-y-4 pb-10">
      <Link to="/accounting/purchases" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-emerald-700">
        <HiOutlineArrowLeft className="w-3.5 h-3.5" /> Compras
      </Link>
      {error && <p className="text-sm text-rose-600 py-6 text-center">{error}</p>}
      {!error && !data && <p className="text-sm text-slate-400 py-10 text-center">Cargando factura…</p>}
      {data && (
        <div className="space-y-4">
          {/* Cabecera: proveedor + estado + importes clave */}
          <div className="flex flex-wrap items-start justify-between gap-3 bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 sm:p-5">
            <div className="min-w-0">
              <h1 className="text-xl font-bold text-slate-800 font-mono">{d.serie || '(sin número)'}</h1>
              <div className="text-base font-semibold text-slate-800 break-words">{s.razonSocial || '—'}</div>
              <div className="text-xs text-slate-500 font-mono">{s.ruc}</div>
              <div className="text-xs text-slate-500 mt-0.5">
                {docTypeLabel[d.docType] || d.docType} <span className="font-mono">{d.serie}</span>
                {d.importedFromXml ? ' · importada del XML' : d.importedFromTxt ? ' · importada del SRI (TXT)' : ''}
              </div>
            </div>
            <span className={`inline-block px-2.5 py-1 rounded-full text-xs font-medium ${st.badgeClass || ''}`}>{st.label || d.status}</span>
            <div className="w-full flex flex-wrap gap-2">
              {d.journalEntry && (d.status === 'REGISTRADA' || d.status === 'PAGADA') && (
                <button type="button" onClick={() => setVerAsiento(true)} className="btn-secondary">
                  <HiOutlineBookOpen className="w-4 h-4" /> Ver asiento contable
                </button>
              )}
              {editable && (
                <Link to={`/accounting/purchases?doc=${d._id}`} className="btn-secondary">
                  <HiOutlinePencilSquare className="w-4 h-4" /> Editar
                </Link>
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            {[
              ['Total factura', d.total, 'text-slate-800'],
              ['Retenciones', d.retentionTotal, 'text-slate-600'],
              ['Neto a pagar', neto, 'text-slate-800'],
              ['Saldo pendiente', anulada ? 0 : (pagos?.saldo ?? d.balance), (Number(pagos?.saldo ?? d.balance) > 0.005 && !anulada) ? 'text-amber-700' : 'text-emerald-700'],
            ].map(([label, value, cls]) => (
              <div key={label} className="bg-white border border-slate-200 rounded-lg px-3 py-2">
                <div className="text-[11px] uppercase text-slate-400">{label}</div>
                <div className={`font-mono font-semibold ${cls}`}>${fmt(value)}</div>
              </div>
            ))}
          </div>

          <Seccion title="Comprobante">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
              <Dato label="Fecha de emisión">{fmtDate(d.fechaEmision)}</Dato>
              <Dato label="Fecha de registro">{fmtDate(d.fechaRegistro || d.createdAt)}</Dato>
              <Dato label="Vencimiento">{d.fechaVencimiento ? `${fmtDate(d.fechaVencimiento)}${d.creditDays ? ` (${d.creditDays} días)` : ''}` : (d.creditDays ? `${d.creditDays} días de crédito` : 'Contado')}</Dato>
              <Dato label="Centro de costo">{nombre(d.costCenter)}</Dato>
              <Dato label="Forma de pago (SRI)">{d.paymentMethodSri}</Dato>
              <Dato label="Sustenta crédito tributario">{d.deductible === false ? 'No' : 'Sí'}</Dato>
              <Dato label="N° de autorización" mono wide>{d.autorizacion}</Dato>
              <Dato label="Clave de acceso" mono wide>{d.claveAcceso && d.claveAcceso !== d.autorizacion ? d.claveAcceso : ''}</Dato>
              <Dato label="Registrada por">{nombre(d.createdBy)}</Dato>
              <Dato label="Contabilizada por">{d.authorizedBy ? `${nombre(d.authorizedBy)}${d.authorizedAt ? ` · ${fechaHora(d.authorizedAt)}` : ''}` : ''}</Dato>
            </div>
          </Seccion>

          <Seccion title="Proveedor">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
              <Dato label="Razón social">{s.razonSocial}</Dato>
              <Dato label="RUC / cédula" mono>{s.ruc}</Dato>
              <Dato label="Teléfono">{s.phone}</Dato>
              <Dato label="Correo">{s.email}</Dato>
              <Dato label="Dirección" wide>{s.address}</Dato>
            </div>
          </Seccion>

          <Seccion title={`Detalle (${items.length} línea${items.length === 1 ? '' : 's'})`}>
            <div className="border border-slate-200 rounded-xl overflow-x-auto">
              <table className="tbl text-sm min-w-[760px]">
                <thead className="bg-emerald-50 text-xs uppercase"><tr>
                  <th className="px-3 py-2 text-left">Descripción</th>
                  <th className="px-3 py-2 text-right">Cant.</th>
                  <th className="px-3 py-2 text-right">P. unit.</th>
                  <th className="px-3 py-2 text-right">Desc.</th>
                  <th className="px-3 py-2 text-right">Subtotal</th>
                  <th className="px-3 py-2 text-right">IVA</th>
                  <th className="px-3 py-2 text-left">Imputación</th>
                </tr></thead>
                <tbody>
                  {items.map((it, i) => {
                    const tipo = it.lineType || (it.product ? 'INVENTARIO' : 'GASTO');
                    const rets = (Array.isArray(it.retentions) && it.retentions.length ? it.retentions : (it.retention ? [it.retention] : []))
                      .filter((r) => r && (r.code || r.rate || r.percentage));
                    return (
                      <tr key={it.lineId || it._id || i} className="border-t align-top">
                        <td className="px-3 py-2">
                          <div className="text-slate-800">{it.description}</div>
                          {it.product && typeof it.product === 'object' && (
                            <div className="text-[11px] text-slate-500"><span className="font-mono">{it.product.code}</span> · {it.product.name}</div>
                          )}
                          {tipo === 'ACTIVO_FIJO' && it.fixedAsset?.name && <div className="text-[11px] text-slate-500">Activo: {it.fixedAsset.name}{it.fixedAsset.serial ? ` · Serie ${it.fixedAsset.serial}` : ''}</div>}
                          {(it.lot || it.expiryDate) && <div className="text-[11px] text-slate-500">{it.lot ? `Lote ${it.lot}` : ''}{it.lot && it.expiryDate ? ' · ' : ''}{it.expiryDate ? `Vence ${fmtDate(it.expiryDate)}` : ''}</div>}
                          {!!rets.length && (
                            <div className="text-[11px] text-slate-500">
                              Retención: {rets.map((r) => `${r.type || ''} ${r.code || ''} ${Number(r.rate ?? r.percentage ?? 0)}%`.trim()).join(' · ')}
                            </div>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{Number(it.quantity || 0).toLocaleString('es-EC', { maximumFractionDigits: 4 })}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{fmt(it.unitPrice)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums">{Number(it.discount) ? fmt(it.discount) : '—'}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums font-medium">{fmt(it.subtotal)}</td>
                        <td className="px-3 py-2 text-right font-mono tabular-nums whitespace-nowrap">
                          {fmt(it.ivaAmount)}<div className="text-[10px] text-slate-400">{Number(it.ivaRate || 0)}%</div>
                        </td>
                        <td className="px-3 py-2 text-xs text-slate-600">
                          <div className="font-medium text-slate-700">{LINE_TYPE_LABEL[tipo] || tipo}</div>
                          {(it.accountSplits || []).length
                            ? it.accountSplits.map((sp, k) => <div key={k}>{cuenta(sp.account)} · ${fmt(sp.amount)}</div>)
                            : cuenta(it.account) && <div>{cuenta(it.account)}</div>}
                          {nombre(it.inventoryCategory) && <div>Categoría: {nombre(it.inventoryCategory)}</div>}
                          {nombre(it.warehouse) && <div>Bodega: {nombre(it.warehouse)}</div>}
                          {nombre(it.costCenter) && <div>C. costo: {nombre(it.costCenter)}</div>}
                        </td>
                      </tr>
                    );
                  })}
                  {!items.length && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-400">La factura no tiene líneas.</td></tr>}
                </tbody>
              </table>
            </div>
          </Seccion>

          <div className="grid gap-5 md:grid-cols-2">
            <Seccion title="Totales">
              <div className="border border-slate-200 rounded-xl divide-y text-sm">
                {[
                  ...subtotales,
                  ['Descuento', d.discount],
                  ['Subtotal', d.subtotal, true],
                  ['IVA', d.iva],
                  ...(Number(d.vatNonCreditAmount) > 0.004 ? [['  IVA que no da crédito', d.vatNonCreditAmount]] : []),
                  ['ICE', d.ice], ['Propina', d.propina],
                  ['TOTAL', d.total, true],
                ].filter(([label, v, siempre]) => siempre || Number(v) > 0.004 || label === 'IVA').map(([label, v, fuerte]) => (
                  <div key={label} className={`flex justify-between px-3 py-1.5 ${fuerte ? 'font-semibold bg-slate-50' : ''}`}>
                    <span className="text-slate-600">{label}</span><span className="font-mono tabular-nums">${fmt(v)}</span>
                  </div>
                ))}
              </div>
              {d.sriTotals?.total != null && (
                <p className={`text-[11px] ${d.sriMismatchAccepted ? 'text-amber-700' : 'text-slate-500'}`}>
                  Según el SRI: subtotal ${fmt(d.sriTotals.subtotal)} · IVA ${fmt(d.sriTotals.iva)} · total ${fmt(d.sriTotals.total)}
                  {d.sriMismatchAccepted ? ' — diferencia aceptada al contabilizar.' : ''}
                </p>
              )}
            </Seccion>

            <Seccion title="Retenciones">
              {rv && (
                <div className="bg-slate-50 rounded-lg px-3 py-2 text-xs text-slate-600 space-y-0.5">
                  <div>Comprobante <b className="font-mono">{retVoucherNumber(rv)}</b> · {RET_ESTADO_LABEL[rv.estado] || rv.estado}</div>
                  <div>Emitido {fmtDate(rv.fechaEmision)}{rv.periodoFiscal ? ` · periodo ${rv.periodoFiscal}` : ''}</div>
                  {rv.numeroAutorizacion && <div className="font-mono break-all">{rv.numeroAutorizacion}</div>}
                </div>
              )}
              {!rv && d.retentionNumber && <p className="text-xs text-slate-600">Comprobante N° <span className="font-mono">{d.retentionNumber}</span></p>}
              {!rv && PERIODO(d.retentionPeriodMonth, d.retentionPeriodYear) && <p className="text-xs text-slate-500">Periodo fiscal: {PERIODO(d.retentionPeriodMonth, d.retentionPeriodYear)}</p>}
              {(d.retentions || []).length ? (
                <div className="border border-slate-200 rounded-xl overflow-x-auto">
                  <table className="tbl text-xs">
                    <thead className="bg-emerald-50 uppercase"><tr>
                      <th className="px-2 py-1.5 text-left">Tipo</th><th className="px-2 py-1.5 text-left">Código</th>
                      <th className="px-2 py-1.5 text-right">Base</th><th className="px-2 py-1.5 text-right">%</th>
                      <th className="px-2 py-1.5 text-right">Valor</th>
                    </tr></thead>
                    <tbody>
                      {d.retentions.map((r, i) => (
                        <tr key={i} className="border-t">
                          <td className="px-2 py-1.5">{r.type}</td>
                          <td className="px-2 py-1.5" title={r.description || ''}>
                            <span className="font-mono">{r.code}</span>
                            {r.description && <div className="text-[10px] text-slate-400 max-w-[180px] truncate">{r.description}</div>}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono">{fmt(r.baseAmount)}</td>
                          <td className="px-2 py-1.5 text-right font-mono">{Number(r.percentage || 0)}</td>
                          <td className="px-2 py-1.5 text-right font-mono font-semibold">{fmt(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-xs text-slate-400">Sin retenciones.</p>}
            </Seccion>
          </div>

          {(d.status === 'REGISTRADA' || d.status === 'PAGADA') && (
            <Seccion title="Pagos y abonos">
              {!pagos ? <p className="text-xs text-slate-400">Cargando abonos…</p> : (pagos.rows || []).length ? (
                <div className="border border-slate-200 rounded-xl overflow-x-auto">
                  <table className="tbl text-xs min-w-[520px]">
                    <thead className="bg-emerald-50 uppercase"><tr>
                      <th className="px-2 py-1.5 text-left">N° pago</th><th className="px-2 py-1.5 text-left">Fecha</th>
                      <th className="px-2 py-1.5 text-left">Método</th><th className="px-2 py-1.5 text-left">Banco / referencia</th>
                      <th className="px-2 py-1.5 text-right">Abono</th>
                    </tr></thead>
                    <tbody>
                      {pagos.rows.map((r) => (
                        <tr key={r._id} className={`border-t ${r.status === 'ANULADO' ? 'text-slate-400 line-through' : ''}`}>
                          <td className="px-2 py-1.5 font-mono">{r.number}</td>
                          <td className="px-2 py-1.5">{fmtDate(r.date)}</td>
                          <td className="px-2 py-1.5">{payMethodLabel[r.method] || r.method}</td>
                          <td className="px-2 py-1.5">
                            {r.bankAccount ? `${r.bankAccount.name}${r.bankAccount.bank ? ` · ${r.bankAccount.bank}` : ''}` : '—'}
                            {(r.reference || r.checkNumber) && <span className="block text-[10px] text-slate-400 font-mono">{r.checkNumber ? `Cheque ${r.checkNumber}` : r.reference}</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right font-mono font-semibold">${fmt(r.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : <p className="text-xs text-slate-400">Todavía no tiene abonos registrados.</p>}
            </Seccion>
          )}

          {d.notes && (
            <Seccion title="Observaciones">
              <p className="text-sm text-slate-700 whitespace-pre-wrap bg-slate-50 rounded-lg px-3 py-2">{d.notes}</p>
            </Seccion>
          )}

        </div>
      )}
      {verAsiento && data && (
        <JournalEntryViewModal
          isOpen={verAsiento}
          onClose={() => setVerAsiento(false)}
          source={{ model: 'PurchaseInvoice', ref: data._id }}
          title={`Asientos de la compra ${data.serie || ''}`}
        />
      )}
    </div>
  );
}
