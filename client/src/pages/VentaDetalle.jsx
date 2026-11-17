import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import {
  HiOutlineDocumentArrowDown, HiOutlineEnvelope, HiOutlineArrowPath, HiOutlineCalculator,
  HiOutlineBanknotes, HiOutlineDocumentText, HiOutlineArrowLeft,
} from 'react-icons/hi2';
import api from '../api/axios';
import Modal from '../components/Modal';
import DateInput from '../components/DateInput';
import NumericInput from '../components/NumericInput';
import JournalEntryViewModal from '../components/JournalEntryViewModal';
import { useAuth } from '../context/AuthContext';
import { fmtDate, fmtDateTime, todayEc } from '../utils/date';
import { newIdempotencyKey, withIdempotencyKey, intentKey } from '../utils/idempotency';

/**
 * DETALLE DE FACTURA / VENTA en su propia página (nov-2026). Se abre en una pestaña nueva al
 * hacer clic en el número de la factura (Facturación y Reportes de ventas).
 *
 * Reúne lo que el contador pedía y antes estaba repartido entre la pestaña «Ventas» (ya
 * retirada) y el modal de Facturas: qué se vendió, cómo se pagó (cada método del pago
 * dividido con su banco, tarjeta, lote y voucher), la factura con su bitácora del SRI, los
 * cobros posteriores de un saldo a crédito y las notas de crédito.
 *
 * `:id` puede ser de la venta o de la factura: el backend resuelve uno u otro.
 */

const ESTADO_FACTURA = {
  AUTORIZADO: ['Autorizada', 'bg-emerald-100 text-emerald-700'],
  RECIBIDA: ['Recibida (pend. autorización)', 'bg-blue-100 text-blue-700'],
  EN_PROCESO: ['En proceso en el SRI', 'bg-amber-100 text-amber-700'],
  EN_COLA: ['Pendiente de envío (SRI)', 'bg-slate-100 text-slate-600'],
  DEVUELTA: ['Devuelta por el SRI', 'bg-red-100 text-red-700'],
  NO_AUTORIZADO: ['No autorizada', 'bg-red-100 text-red-700'],
  ERROR: ['Error de envío', 'bg-red-100 text-red-700'],
  ANULADA: ['Anulada', 'bg-slate-300 text-slate-700'],
};
const PENDIENTES = ['EN_COLA', 'RECIBIDA', 'EN_PROCESO', 'ERROR', 'DEVUELTA', 'NO_AUTORIZADO'];
const CORREO = { NO_CONFIGURADO: 'Envío automático no configurado', SIN_CORREO: 'Sin correo del comprador', PENDIENTE: 'Pendiente de envío', ENVIANDO: 'Enviando', ENVIADO: 'Enviado', ERROR: 'Error de envío' };
const METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', credito: 'Crédito (por cobrar)', anticipo: 'Saldo a favor / anticipo' };
const METODO_COBRO = { EFECTIVO: 'Efectivo', TRANSFERENCIA: 'Transferencia', CHEQUE: 'Cheque', TARJETA: 'Tarjeta', DEPOSITO: 'Depósito', OTRO: 'Otro' };
const TIPO_TARJETA = { DEBITO: 'Débito', CREDITO: 'Crédito', CORRIENTE: 'Corriente' };
const DIFERIDO = { CORRIENTE: 'Corriente', SIN_INTERES: 'Diferido sin intereses', CON_INTERES: 'Diferido con intereses' };
const ENTREGA = { llevado: 'Se lo llevó', aplicado: 'Aplicado en la clínica', en_clinica: 'Queda en la clínica' };

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

// ¿El SRI autorizó en un día calendario distinto al de emisión? Se conserva la fecha de
// emisión original y se avisa (venía del antiguo modal de Facturas).
function autorizadaOtroDia(inv) {
  if (!inv?.fechaAutorizacion || !inv?.fechaEmision) return false;
  const [dd, mm, yyyy] = String(inv.fechaEmision).split('/');
  if (!dd || !mm || !yyyy) return false;
  const ec = new Date(new Date(inv.fechaAutorizacion).getTime() - 5 * 60 * 60 * 1000); // Ecuador UTC−5
  const autKey = `${String(ec.getUTCDate()).padStart(2, '0')}/${String(ec.getUTCMonth() + 1).padStart(2, '0')}/${ec.getUTCFullYear()}`;
  return autKey !== `${dd.padStart(2, '0')}/${mm.padStart(2, '0')}/${yyyy}`;
}
const nombre = (x) => (x && typeof x === 'object' ? x.name || '' : '');
const banco = (b) => (b && typeof b === 'object' ? [b.name, b.bank, b.accountNumber ? `N° ${b.accountNumber}` : ''].filter(Boolean).join(' · ') : '');
const numeroFactura = (f) => (f ? `${f.estab}-${f.ptoEmi}-${String(f.secuencial || '').padStart(9, '0')}` : '');

function Dato({ label, children, mono = false, wide = false }) {
  if (children === null || children === undefined || children === '' || children === false) return null;
  return (
    <div className={wide ? 'sm:col-span-2 lg:col-span-3' : ''}>
      <div className="text-[11px] uppercase tracking-wide font-semibold text-slate-400">{label}</div>
      <div className={`text-sm text-slate-800 break-words ${mono ? 'font-mono text-xs break-all' : ''}`}>{children}</div>
    </div>
  );
}

function Tarjeta({ title, icon: Icon, children, right }) {
  return (
    <section className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 sm:p-5 space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-emerald-800 flex items-center gap-2">{Icon && <Icon className="w-4 h-4" />}{title}</h2>
        {right}
      </div>
      {children}
    </section>
  );
}

/** Un pago de la venta: método, monto y TODO su rastro (banco, tarjeta, lote, voucher…). */
function FilaPago({ p }) {
  const tarjeta = p.method === 'tarjeta';
  const detalle = [
    banco(p.bankAccount) && `Cuenta: ${banco(p.bankAccount)}`,
    tarjeta && (nombre(p.creditCard) || p.cardBrandSnapshot) && `Tarjeta: ${[nombre(p.creditCard), p.cardBrandSnapshot].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' · ')}`,
    tarjeta && p.cardTypeSnapshot && `Tipo: ${TIPO_TARJETA[p.cardTypeSnapshot] || p.cardTypeSnapshot}`,
    tarjeta && p.cardPos && `POS: ${p.cardPos}`,
    tarjeta && p.cardLote && `Lote: ${p.cardLote}`,
    tarjeta && p.cardVoucher && `Voucher: ${p.cardVoucher}`,
    tarjeta && p.cardDeferredType && p.cardDeferredType !== 'CORRIENTE' && `${DIFERIDO[p.cardDeferredType]}${p.cardDeferredMonths ? ` a ${p.cardDeferredMonths} meses` : ''}`,
    p.reference && !(p.method === 'efectivo' && p.reference === 'Efectivo') && `Referencia: ${p.reference}`,
    p.date && `Fecha: ${fmtDate(p.date)}`,
  ].filter(Boolean);
  return (
    <tr className="border-t align-top">
      <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{METODO[p.method] || p.method}</td>
      <td className="px-3 py-2 text-xs text-slate-600">{detalle.length ? detalle.map((d) => <div key={d}>{d}</div>) : <span className="text-slate-400">—</span>}</td>
      <td className="px-3 py-2 text-right font-mono font-semibold whitespace-nowrap">{money(p.amount)}</td>
    </tr>
  );
}

export default function VentaDetalle() {
  const { id } = useParams();
  const { hasRole } = useAuth();
  const canRetry = hasRole('admin', 'cajero', 'contabilidad');
  const canInvoice = hasRole('admin', 'cajero');
  const canAccounting = hasRole('admin', 'contabilidad');

  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [verAsientos, setVerAsientos] = useState(false);
  const [cobro, setCobro] = useState(null); // formulario de cobro del saldo
  const [cuentas, setCuentas] = useState([]);

  const cargar = useCallback(async () => {
    try {
      const r = await api.get(`/sales/${id}/detalle`);
      setData(r.data);
      setError('');
    } catch (e) {
      setError(e.response?.data?.message || 'No se pudo cargar la factura');
    }
  }, [id]);
  useEffect(() => { cargar(); }, [cargar]);

  const sale = data?.sale || null;
  const facturas = (data?.invoices || []).filter(Boolean);
  // La factura vigente: la última que no se anuló; si todas están anuladas, la última.
  const factura = [...facturas].reverse().find((f) => f.estado !== 'ANULADA') || facturas[facturas.length - 1] || null;
  const anteriores = facturas.filter((f) => f !== factura);

  useEffect(() => {
    const n = factura ? `Factura ${numeroFactura(factura)}` : sale ? `Venta ${sale.saleNumber || ''}` : 'Detalle de factura';
    document.title = `${n} · Vikingo`;
  }, [factura, sale]);

  const verPdf = async () => {
    try {
      const res = await api.get(`/invoices/${factura._id}/pdf`, { responseType: 'blob' });
      window.open(URL.createObjectURL(new Blob([res.data], { type: 'application/pdf' })), '_blank');
    } catch (e) { toast.error(e.response?.data?.message || 'Error al generar el PDF'); }
  };
  const reintentar = async () => {
    setBusy(true);
    try { const r = await api.post(`/invoices/${factura._id}/retry`); toast(r.data?.message || 'Reintento procesado'); await cargar(); }
    catch (e) { toast.error(e.response?.data?.message || 'Error al reintentar'); }
    finally { setBusy(false); }
  };
  const enviarCorreo = async () => {
    const email = window.prompt('Correo al que se enviará la factura:', factura.emailDelivery?.recipient || factura.emailComprador || '');
    if (email === null) return;
    setBusy(true);
    try { await api.post(`/invoices/${factura._id}/email`, { email }); toast.success('Factura programada para envío por correo'); await cargar(); }
    catch (e) { toast.error(e.response?.data?.message || 'No se pudo programar el envío'); }
    finally { setBusy(false); }
  };
  const facturar = async () => {
    setBusy(true);
    try { const r = await api.post(`/invoices/from-sale/${sale._id}`); toast.success(r.data?.message || 'Factura emitida'); await cargar(); }
    catch (e) { toast.error(e.response?.data?.message || 'No se pudo facturar'); }
    finally { setBusy(false); }
  };

  const abrirCobro = () => {
    setCobro({ date: todayEc(), amount: +(Number(sale.balance) || 0).toFixed(2), method: 'EFECTIVO', bankAccount: '', reference: '', intent: newIdempotencyKey() });
    if (!cuentas.length) api.get('/banks/payment-options').then((r) => setCuentas(r.data?.accounts || [])).catch(() => setCuentas([]));
  };
  // Mismo cobro que hacía la pestaña Ventas: un documento COBRO aplicado a la venta.
  const registrarCobro = async (e) => {
    e.preventDefault();
    if (busy) return;
    const amount = Number(cobro.amount) || 0;
    if (amount <= 0) return toast.error('Monto inválido');
    if (amount > Number(sale.balance || 0) + 0.01) return toast.error(`El monto excede el saldo (${money(sale.balance)})`);
    const sinBanco = ['EFECTIVO', 'TARJETA'].includes(cobro.method);
    if (!sinBanco && !cobro.bankAccount) return toast.error('Selecciona la cuenta bancaria');
    setBusy(true);
    try {
      const payload = {
        type: 'COBRO', date: cobro.date, partyModel: 'Patient',
        partyRef: sale.patient?._id || sale.patient || null, partyName: sale.clientName || '', partyId: sale.clientCedula || '',
        method: cobro.method, bankAccount: sinBanco ? null : cobro.bankAccount, reference: cobro.reference,
        applications: [{ docModel: 'Sale', docRef: sale._id, amount }], advanceAmount: 0,
        description: `Cobro venta ${sale.saleNumber || ''}`.trim(),
      };
      const huella = [payload.method, payload.bankAccount, payload.date, sale._id, amount];
      await api.post('/payments', payload, withIdempotencyKey(intentKey(cobro.intent, huella)));
      toast.success('Cobro registrado');
      setCobro(null);
      await cargar();
    } catch (err) { toast.error(err.response?.data?.message || 'Error'); }
    finally { setBusy(false); }
  };

  if (error) {
    return (
      <div className="max-w-3xl mx-auto py-16 text-center space-y-3">
        <p className="text-slate-600">{error}</p>
        <Link to="/invoices" className="text-emerald-700 text-sm underline">Ir a Facturación</Link>
      </div>
    );
  }
  if (!data) return <div className="max-w-6xl mx-auto py-16 text-center text-slate-400 text-sm">Cargando factura…</div>;

  const [estadoLabel, estadoClase] = ESTADO_FACTURA[factura?.estado] || [factura?.estado || '', 'bg-slate-100 text-slate-600'];
  const items = sale?.items || [];
  // Ventas viejas sin el arreglo `payments`: un solo pago con los campos de la venta.
  const pagos = sale?.payments?.length ? sale.payments : sale ? [{
    method: sale.paymentMethod, amount: sale.total, bankAccount: sale.bankAccount, creditCard: sale.creditCard,
    cardPos: sale.cardPos, cardLote: sale.cardLote, cardVoucher: sale.cardVoucher,
    cardDeferredType: sale.cardDeferredType, cardDeferredMonths: sale.cardDeferredMonths,
  }] : [];
  const metodos = [...new Set(pagos.map((p) => METODO[p.method] || p.method))];
  const pac = sale?.patient && typeof sale.patient === 'object' ? sale.patient : null;
  const subtotales = sale ? [
    ['Subtotal con IVA', sale.taxableSubtotal], ['Subtotal 0 %', sale.subtotal0],
    ['Exento de IVA', sale.subtotalExento], ['No objeto de IVA', sale.subtotalNoObjeto],
  ].filter(([, v]) => Number(v) > 0.004) : [];

  return (
    <div className="max-w-6xl mx-auto space-y-4 pb-10">
      <Link to="/invoices" className="inline-flex items-center gap-1 text-xs text-slate-500 hover:text-emerald-700">
        <HiOutlineArrowLeft className="w-3.5 h-3.5" /> Facturación
      </Link>

      {/* Cabecera */}
      <div className="bg-white rounded-2xl shadow-md shadow-slate-200/60 border border-emerald-100 p-4 sm:p-5 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-bold text-slate-800 font-mono">{factura ? numeroFactura(factura) : `Venta ${sale?.saleNumber || ''}`}</h1>
            {factura ? <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${estadoClase}`}>{estadoLabel}</span>
              : <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-amber-100 text-amber-700">Sin factura</span>}
            {sale?.status === 'anulada' && <span className="text-xs px-2 py-0.5 rounded-full font-medium bg-red-100 text-red-700">Venta anulada</span>}
          </div>
          <p className="text-sm text-slate-700">{factura?.razonSocialComprador || sale?.clientName} <span className="text-slate-400 font-mono text-xs">{factura?.identificacionComprador || sale?.clientCedula}</span></p>
          <p className="text-xs text-slate-500">
            {sale?.saleNumber && <>Venta {sale.saleNumber} · </>}
            {fmtDateTime(sale?.createdAt || factura?.createdAt)}
            {metodos.length > 0 && <> · Pagado con {metodos.join(' + ')}</>}
          </p>
        </div>
        <div className="text-right">
          <div className="text-[11px] uppercase text-slate-400">Total</div>
          <div className="text-2xl font-bold text-emerald-700 font-mono">{money(sale?.total ?? factura?.importeTotal)}</div>
          {Number(sale?.balance) > 0.01 && sale?.status !== 'anulada' && <div className="text-xs font-medium text-amber-700">Saldo por cobrar {money(sale.balance)}</div>}
        </div>
        <div className="w-full flex flex-wrap gap-2">
          {factura && factura.estado !== 'NO_AUTORIZADO' && (
            <button type="button" onClick={verPdf} className="btn-secondary"><HiOutlineDocumentArrowDown className="w-4 h-4" /> Ver RIDE (PDF)</button>
          )}
          {factura?.estado === 'AUTORIZADO' && canRetry && !['PENDIENTE', 'ENVIANDO'].includes(factura.emailDelivery?.status) && (
            <button type="button" disabled={busy} onClick={enviarCorreo} className="btn-secondary disabled:opacity-50"><HiOutlineEnvelope className="w-4 h-4" /> {factura.emailDelivery?.status === 'ENVIADO' ? 'Reenviar por correo' : 'Enviar por correo'}</button>
          )}
          {factura && canRetry && PENDIENTES.includes(factura.estado) && (
            <button type="button" disabled={busy} onClick={reintentar} className="btn-secondary disabled:opacity-50"><HiOutlineArrowPath className="w-4 h-4" /> Reintentar envío al SRI</button>
          )}
          {sale && canInvoice && sale.status === 'completada' && (!factura || factura.estado === 'NO_AUTORIZADO') && (
            <button type="button" disabled={busy} onClick={facturar} className="btn-primary disabled:opacity-50"><HiOutlineDocumentText className="w-4 h-4" /> {factura ? 'Facturar de nuevo' : 'Facturar electrónicamente'}</button>
          )}
          {sale && sale.status === 'completada' && Number(sale.balance) > 0.01 && (
            <button type="button" onClick={abrirCobro} className="btn-primary"><HiOutlineBanknotes className="w-4 h-4" /> Registrar cobro</button>
          )}
          {sale && canAccounting && sale.journalEntry && (
            <button type="button" onClick={() => setVerAsientos(true)} className="btn-secondary"><HiOutlineCalculator className="w-4 h-4" /> Ver asientos contables</button>
          )}
        </div>
      </div>

      {/* Qué se vendió */}
      {sale && (
        <Tarjeta title={`Qué se vendió (${items.length} ítem${items.length === 1 ? '' : 's'})`}>
          <div className="border border-slate-200 rounded-xl overflow-x-auto">
            <table className="tbl text-sm min-w-[720px]">
              <thead className="bg-emerald-50 text-xs uppercase text-emerald-700"><tr>
                <th className="px-3 py-2 text-left">Producto / servicio</th>
                <th className="px-3 py-2 text-right">Cant.</th>
                <th className="px-3 py-2 text-right">P. unit.</th>
                <th className="px-3 py-2 text-right">Desc.</th>
                <th className="px-3 py-2 text-right">Base</th>
                <th className="px-3 py-2 text-right">IVA</th>
                <th className="px-3 py-2 text-right">Total</th>
              </tr></thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={it._id || i} className="border-t align-top">
                    <td className="px-3 py-2">
                      <div className="text-slate-800 font-medium">{it.productName || it.product?.name}</div>
                      <div className="text-[11px] text-slate-500">
                        <span className="font-mono">{it.productCode || it.product?.code}</span>
                        {it.category ? ` · ${it.category}` : ''}
                        {nombre(it.warehouse) ? ` · Bodega ${nombre(it.warehouse)}` : ''}
                        {ENTREGA[it.delivery] ? ` · ${ENTREGA[it.delivery]}` : ''}
                      </div>
                      {it.prepaid && <div className="text-[11px] text-sky-700">Prepagado{it.appliedNow != null ? ` · hoy se aplica ${it.appliedNow} de ${it.quantity}` : ''}</div>}
                      {(it.linkedItems || []).length > 0 && (
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Incluye: {it.linkedItems.map((l) => `${l.productName || l.productCode} ×${l.quantity}${l.source === 'paciente' ? ' (del paciente)' : l.source === 'trajo' ? ' (lo trajo)' : ''}`).join(', ')}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono">{it.quantity}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(it.unitPrice)}</td>
                    <td className="px-3 py-2 text-right font-mono">{Number(it.discount) ? money(it.discount) : '—'}</td>
                    <td className="px-3 py-2 text-right font-mono">{money(it.taxBase ?? it.subtotal)}</td>
                    <td className="px-3 py-2 text-right font-mono whitespace-nowrap">{money(it.taxAmount)}<div className="text-[10px] text-slate-400">{Number(it.taxRate || 0)}%</div></td>
                    <td className="px-3 py-2 text-right font-mono font-semibold">{money(it.lineTotal || it.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div className="text-xs text-slate-600 space-y-1">
              {sale.discountReason && <p><b>Motivo del descuento:</b> {sale.discountReason}</p>}
              {sale.notes && <p><b>Notas:</b> {sale.notes}</p>}
            </div>
            <div className="border border-slate-200 rounded-xl divide-y text-sm">
              {[...subtotales, ['Descuento', sale.discountTotal], ['IVA', sale.taxAmount, true], ['TOTAL', sale.total, true, true]]
                .filter(([, v, siempre]) => siempre || Number(v) > 0.004)
                .map(([label, v, , fuerte]) => (
                  <div key={label} className={`flex justify-between px-3 py-1.5 ${fuerte ? 'font-semibold bg-slate-50' : ''}`}>
                    <span className="text-slate-600">{label}</span><span className="font-mono">{money(v)}</span>
                  </div>
                ))}
            </div>
          </div>
        </Tarjeta>
      )}

      {/* Cómo se pagó */}
      {sale && (
        <Tarjeta title={pagos.length > 1 ? `Cómo se pagó (${pagos.length} métodos)` : 'Cómo se pagó'} icon={HiOutlineBanknotes}>
          <div className="border border-slate-200 rounded-xl overflow-x-auto">
            <table className="tbl text-sm min-w-[520px]">
              <thead className="bg-emerald-50 text-xs uppercase text-emerald-700"><tr>
                <th className="px-3 py-2 text-left">Método</th><th className="px-3 py-2 text-left">Detalle</th><th className="px-3 py-2 text-right">Monto</th>
              </tr></thead>
              <tbody>{pagos.map((p, i) => <FilaPago key={i} p={p} />)}</tbody>
              {pagos.length > 1 && (
                <tfoot className="bg-slate-50 font-semibold"><tr>
                  <td colSpan={2} className="px-3 py-2 text-right">Total pagado</td>
                  <td className="px-3 py-2 text-right font-mono">{money(pagos.reduce((s, p) => s + (Number(p.amount) || 0), 0))}</td>
                </tr></tfoot>
              )}
            </table>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-4 gap-y-3">
            <Dato label="Plazo de crédito">{sale.creditDays ? `${sale.creditDays} días` : ''}</Dato>
            <Dato label="Vence">{sale.dueDate ? fmtDate(sale.dueDate) : ''}</Dato>
            <Dato label="Saldo por cobrar">{Number(sale.balance) > 0.01 ? money(sale.balance) : ''}</Dato>
            <Dato label="Queda a favor del paciente">{Number(sale.advanceCreated) > 0.004 ? money(sale.advanceCreated) : ''}</Dato>
          </div>
          {sale.paymentEvidenceStatus === 'INCOMPLETA' && (
            <p className="text-xs bg-amber-50 border border-amber-200 text-amber-800 rounded-lg px-3 py-2">
              Pago sin comprobante completo{Number(sale.unverifiedPaymentAmount) > 0 ? ` (${money(sale.unverifiedPaymentAmount)} sin verificar)` : ''}: falta banco, lote o voucher en algún método.
            </p>
          )}
          {(data.cobros || []).length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-semibold text-slate-600">Cobros posteriores del saldo</p>
              <div className="border border-slate-200 rounded-xl overflow-x-auto">
                <table className="tbl text-xs min-w-[560px]">
                  <thead className="bg-slate-50 uppercase"><tr>
                    <th className="px-3 py-1.5 text-left">N° cobro</th><th className="px-3 py-1.5 text-left">Fecha</th>
                    <th className="px-3 py-1.5 text-left">Forma</th><th className="px-3 py-1.5 text-left">Banco / referencia</th>
                    <th className="px-3 py-1.5 text-left">Registró</th><th className="px-3 py-1.5 text-right">Monto</th>
                  </tr></thead>
                  <tbody>
                    {data.cobros.map((c) => (
                      <tr key={c._id} className={`border-t ${c.status === 'ANULADO' ? 'text-slate-400 line-through' : ''}`}>
                        <td className="px-3 py-1.5 font-mono">{c.number}</td>
                        <td className="px-3 py-1.5">{fmtDate(c.date)}</td>
                        <td className="px-3 py-1.5">{METODO_COBRO[c.method] || c.method}</td>
                        <td className="px-3 py-1.5">{banco(c.bankAccount) || '—'}{(c.reference || c.checkNumber) && <span className="block text-[10px] text-slate-400">{c.checkNumber ? `Cheque ${c.checkNumber}` : c.reference}</span>}</td>
                        <td className="px-3 py-1.5">{c.createdBy || '—'}</td>
                        <td className="px-3 py-1.5 text-right font-mono font-semibold">{money(c.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </Tarjeta>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Cliente */}
        <Tarjeta title="Cliente">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
            <Dato label="Nombre / razón social">{factura?.razonSocialComprador || sale?.clientName}</Dato>
            <Dato label="Cédula / RUC" mono>{factura?.identificacionComprador || sale?.clientCedula}</Dato>
            <Dato label="Correo">{factura?.emailComprador || sale?.clientEmail || pac?.email}</Dato>
            <Dato label="Teléfono">{factura?.telefonoComprador || sale?.clientPhone || pac?.phone}</Dato>
            <Dato label="Dirección" wide>{factura?.direccionComprador || sale?.clientAddress || pac?.address}</Dato>
            <Dato label="Paciente registrado" wide>
              {pac ? <Link to={`/patients/${pac._id}`} target="_blank" className="text-emerald-700 hover:underline">{pac.firstName} {pac.lastName} — {pac.cedula}</Link> : ''}
              {pac && sale?.isFirstVisit ? <span className="ml-2 px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-700 uppercase">Nuevo</span> : null}
            </Dato>
          </div>
        </Tarjeta>

        {/* Datos de la venta */}
        {sale && (
          <Tarjeta title="Datos de la venta">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
              <Dato label="N° de venta" mono>{sale.saleNumber}</Dato>
              <Dato label="Fecha y hora">{fmtDateTime(sale.createdAt)}</Dato>
              <Dato label="Cobró">{nombre(sale.cashier) || nombre(sale.createdBy)}</Dato>
              <Dato label="Registró">{nombre(sale.cashier) && nombre(sale.createdBy) !== nombre(sale.cashier) ? nombre(sale.createdBy) : ''}</Dato>
              <Dato label="Caja / punto de emisión">{sale.puntoEmision ? `${sale.puntoEmision.establecimiento}-${sale.puntoEmision.codigo}${sale.puntoEmision.nombre ? ` · ${sale.puntoEmision.nombre}` : ''}` : ''}</Dato>
              <Dato label="Bodega">{nombre(sale.warehouse)}</Dato>
              <Dato label="Centro de costo">{sale.costCenter ? `${sale.costCenter.code || ''} ${sale.costCenter.name || ''}`.trim() : ''}</Dato>
              <Dato label="Cita">{sale.appointment ? `${String(sale.appointment.date || '').slice(0, 10).split('-').reverse().join('/')} ${sale.appointment.startTime || ''}`.trim() : ''}</Dato>
              <Dato label="Doctor">{nombre(sale.doctor)}</Dato>
              <Dato label="Enfermería">{nombre(sale.nurse)}</Dato>
              <Dato label="Recomendado por">{nombre(sale.recommendedBy)}</Dato>
              <Dato label="Call center">{nombre(sale.callCenter)}</Dato>
            </div>
          </Tarjeta>
        )}
      </div>

      {/* Factura electrónica */}
      {factura && (
        <Tarjeta title="Factura electrónica (SRI)" icon={HiOutlineDocumentText}>
          {autorizadaOtroDia(factura) && (
            <p className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
              <b>Advertencia administrativa:</b> se emitió el {factura.fechaEmision} y el SRI la autorizó otro día
              ({fmtDateTime(factura.fechaAutorizacion)}). Se conserva la fecha de emisión original; verifique que la
              autorización esté dentro del plazo permitido por el SRI.
            </p>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-3">
            <Dato label="N° de factura" mono>{numeroFactura(factura)}</Dato>
            <Dato label="Estado">{estadoLabel}</Dato>
            <Dato label="Ambiente">{factura.ambiente === '2' ? 'Producción' : 'Pruebas'}</Dato>
            <Dato label="Fecha de emisión">{factura.fechaEmision}</Dato>
            <Dato label="Fecha de autorización">{factura.fechaAutorizacion ? fmtDateTime(factura.fechaAutorizacion) : ''}</Dato>
            <Dato label="Caja que la emitió">{factura.puntoEmision?.nombre || `${factura.estab}-${factura.ptoEmi}`}</Dato>
            <Dato label="Clave de acceso" mono wide>{factura.claveAcceso}</Dato>
            <Dato label="N° de autorización" mono wide>{factura.numeroAutorizacion && factura.numeroAutorizacion !== factura.claveAcceso ? factura.numeroAutorizacion : ''}</Dato>
            <Dato label="Subtotal sin impuestos">{money(factura.totalSinImpuestos)}</Dato>
            <Dato label="IVA">{money(factura.totalImpuesto)}</Dato>
            <Dato label="Total facturado">{money(factura.importeTotal)}</Dato>
            <Dato label="Envío por correo">{`${CORREO[factura.emailDelivery?.status] || 'No programado'}${factura.emailDelivery?.recipient ? ` · ${factura.emailDelivery.recipient}` : ''}`}</Dato>
            <Dato label="Próximo reintento">{factura.proximoReintento && PENDIENTES.includes(factura.estado) ? fmtDateTime(factura.proximoReintento) : ''}</Dato>
          </div>
          {factura.errorUltimo && <p className="bg-red-50 text-red-700 rounded-xl p-3 text-xs"><b>Último error:</b> {factura.errorUltimo}</p>}
          {factura.mensajesSri?.length > 0 && (
            <div className="bg-amber-50 rounded-xl p-3 text-xs space-y-1">
              <p className="font-semibold text-amber-800">Mensajes del SRI</p>
              {factura.mensajesSri.map((m, i) => <div key={i} className="text-amber-700"><b>{m.identificador}</b> ({m.tipo}): {m.mensaje}{m.informacionAdicional && <> — {m.informacionAdicional}</>}</div>)}
            </div>
          )}
          {factura.motivoAnulacion && (
            <p className="bg-slate-100 rounded-xl p-3 text-xs"><b>Anulada</b>{factura.anuladaAt ? ` el ${fmtDateTime(factura.anuladaAt)}` : ''}{nombre(factura.anuladaBy) ? ` por ${nombre(factura.anuladaBy)}` : ''}: {factura.motivoAnulacion}</p>
          )}
          {factura.intentos?.length > 0 && (
            <div className="bg-slate-50 rounded-xl p-3 text-xs space-y-1 border border-slate-100">
              <p className="font-semibold text-slate-600">Bitácora de envíos al SRI</p>
              <div className="max-h-48 overflow-y-auto space-y-1">
                {[...factura.intentos].reverse().map((it, i) => (
                  <div key={i} className="flex flex-wrap items-start gap-2 text-slate-600">
                    <span className="text-slate-400 shrink-0">{fmtDateTime(it.at)}</span>
                    <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-200 text-slate-700 shrink-0">{it.tipo}</span>
                    <span className="font-medium">{it.estado}</span>
                    {it.mensaje && <span className="text-slate-400">— {it.mensaje}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
          {anteriores.length > 0 && (
            <p className="text-xs text-slate-500">
              Intentos anteriores de esta venta: {anteriores.map((f) => `${numeroFactura(f)} (${(ESTADO_FACTURA[f.estado] || [f.estado])[0]})`).join(' · ')}
            </p>
          )}
        </Tarjeta>
      )}

      {(data.notas || []).length > 0 && (
        <Tarjeta title="Notas de crédito / débito">
          <div className="border border-slate-200 rounded-xl overflow-x-auto">
            <table className="tbl text-xs min-w-[520px]">
              <thead className="bg-slate-50 uppercase"><tr>
                <th className="px-3 py-1.5 text-left">Tipo</th><th className="px-3 py-1.5 text-left">Número</th>
                <th className="px-3 py-1.5 text-left">Fecha</th><th className="px-3 py-1.5 text-left">Motivo</th>
                <th className="px-3 py-1.5 text-right">Total</th>
              </tr></thead>
              <tbody>
                {data.notas.map((n) => (
                  <tr key={n._id} className="border-t">
                    <td className="px-3 py-1.5">{n.kind === 'NC' ? 'Nota de crédito' : 'Nota de débito'}</td>
                    <td className="px-3 py-1.5 font-mono">{n.estab && n.ptoEmi && n.secuencial ? `${n.estab}-${n.ptoEmi}-${n.secuencial}` : n.serie || '—'}</td>
                    <td className="px-3 py-1.5">{fmtDate(n.fechaEmision)}</td>
                    <td className="px-3 py-1.5">{n.motivo || '—'}</td>
                    <td className="px-3 py-1.5 text-right font-mono font-semibold">{money(n.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Tarjeta>
      )}

      {verAsientos && sale && (
        <JournalEntryViewModal isOpen={verAsientos} onClose={() => setVerAsientos(false)}
          source={{ model: 'Sale', ref: sale._id }} title={`Asientos de la venta ${sale.saleNumber || ''}`} />
      )}

      <Modal isOpen={!!cobro} onClose={() => setCobro(null)} title={`Cobrar venta ${sale?.saleNumber || ''}`} size="md">
        {cobro && (
          <form onSubmit={registrarCobro} className="space-y-3">
            <div className="bg-slate-50 rounded-lg p-3 text-sm flex justify-between">
              <span className="text-slate-500">Saldo pendiente</span><b className="font-mono text-amber-600">{money(sale.balance)}</b>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-xs text-slate-600">Fecha
                <DateInput required value={cobro.date} onChange={(e) => setCobro({ ...cobro, date: e.target.value })} className="input mt-1" />
              </label>
              <label className="text-xs text-slate-600">Monto a cobrar
                <NumericInput step="0.01" required value={cobro.amount} onChange={(e) => setCobro({ ...cobro, amount: e.target.value })} className="input mt-1" />
              </label>
              <label className="text-xs text-slate-600">Forma de cobro
                <select value={cobro.method} onChange={(e) => setCobro({ ...cobro, method: e.target.value, bankAccount: '' })} className="input mt-1">
                  {['EFECTIVO', 'TRANSFERENCIA', 'DEPOSITO', 'TARJETA', 'CHEQUE'].map((m) => <option key={m} value={m}>{METODO_COBRO[m]}</option>)}
                </select>
              </label>
              {!['EFECTIVO', 'TARJETA'].includes(cobro.method) && (
                <label className="text-xs text-slate-600">Cuenta bancaria
                  <select required value={cobro.bankAccount} onChange={(e) => setCobro({ ...cobro, bankAccount: e.target.value })} className="input mt-1">
                    <option value="">{cuentas.length ? 'Seleccionar…' : 'No hay cuentas'}</option>
                    {cuentas.map((a) => <option key={a._id} value={a._id}>{a.name} — {a.bank}</option>)}
                  </select>
                </label>
              )}
              <label className="text-xs text-slate-600 sm:col-span-2">Comprobante / referencia
                <input value={cobro.reference} onChange={(e) => setCobro({ ...cobro, reference: e.target.value })} placeholder="N° de transferencia, papeleta, cheque…" className="input mt-1" />
              </label>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setCobro(null)} className="px-4 py-2 bg-slate-200 rounded-xl">Cancelar</button>
              <button disabled={busy} className="px-4 py-2 bg-emerald-600 text-white rounded-xl disabled:opacity-50">{busy ? 'Registrando…' : 'Registrar cobro'}</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
