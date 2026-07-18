import { useState } from 'react';
import {
  HiOutlineArchiveBox, HiOutlineDocumentText, HiOutlineDocumentMagnifyingGlass, HiOutlineArrowRight,
} from 'react-icons/hi2';
import Modal from './Modal';
import JournalEntryViewModal from './JournalEntryViewModal';
import DocumentPreviewModal from './DocumentPreviewModal';
import { fmt, fmtDate } from '../pages/accounting/_utils';
import { sourceLabel } from '../pages/accounting/sourceDocs';

/**
 * DETALLE DE UN MOVIMIENTO DEL KARDEX — el hub de consulta que pidió la contadora.
 *
 * Muestra el movimiento de inventario (solo lectura) y, uno al lado del otro, los TRES accesos
 * de consulta de su sistema anterior, todos en modo lectura (nunca al formulario editable):
 *   1. Movimiento de inventario  → el detalle que ya se ve aquí (esta fila).
 *   2. Movimiento contable        → el/los asiento(s) del documento (compra: ingreso a inventario;
 *      venta: el asiento con el COSTO DE VENTA y la salida de inventario). Se abre por `source`
 *      (documento) para traer TODOS los asientos que generó, no solo uno.
 *   3. Factura                    → la factura de compra/venta en un visor de solo lectura.
 *
 * `movement` es la fila del kardex tal cual la devuelve el servicio (no se recalcula nada).
 */

const TYPE_LABEL = { entrada: 'Ingreso', salida: 'Egreso', ajuste: 'Ajuste', traslado: 'Traslado' };
const TYPE_COLOR = { entrada: 'text-emerald-600', salida: 'text-rose-600', ajuste: 'text-amber-600', traslado: 'text-blue-600' };
// Orígenes que SÍ son una factura consultable (los demás no tienen documento que previsualizar).
const ES_FACTURA = { Sale: true, PurchaseInvoice: true };

export default function InventoryMovementDetailModal({ isOpen, onClose, movement: m, producto, conCostos = true }) {
  const [verAsiento, setVerAsiento] = useState(false);
  const [verFactura, setVerFactura] = useState(false);
  if (!m) return null;

  const doc = m.documento || null;
  const hayAsiento = !!(doc || m.journalEntry);          // por documento o por asiento directo
  const hayFactura = !!(doc && ES_FACTURA[doc.model]);
  const docLabel = doc ? sourceLabel({ sourceModel: doc.model }) : null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Detalle del movimiento" size="2xl">
      {/* ── Los TRES accesos de consulta, uno al lado del otro ─────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Acceso
          activo
          icon={HiOutlineArchiveBox}
          color="emerald"
          titulo="Movimiento de inventario"
          detalle="El movimiento de esta fila (detalle abajo)."
        />
        <Acceso
          icon={HiOutlineDocumentText}
          color="indigo"
          titulo="Movimiento contable"
          detalle={hayAsiento ? 'Ver el asiento (compra: inventario · venta: costo de venta y salida).' : 'Este movimiento no generó asiento.'}
          onClick={hayAsiento ? () => setVerAsiento(true) : null}
        />
        <Acceso
          icon={HiOutlineDocumentMagnifyingGlass}
          color="amber"
          titulo="Factura"
          detalle={hayFactura ? `Ver la ${docLabel.toLowerCase()} (solo consulta).` : (doc ? `${docLabel}: sin factura.` : 'Sin documento de origen.')}
          onClick={hayFactura ? () => setVerFactura(true) : null}
        />
      </div>

      {/* ── Movimiento de inventario (solo lectura) ────────────────────────────────────── */}
      <div className="mt-5 border border-slate-200 rounded-xl overflow-hidden">
        <div className="bg-slate-50 px-4 py-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-600">
          <span>Fecha: <b>{fmtDate(m.date)}</b></span>
          {m.fechaEstimada && <span className="text-[10px] font-bold text-amber-700" title="Histórico sin fecha de documento: se usa la de grabación">FECHA ESTIMADA</span>}
          <span>Tipo: <b className={TYPE_COLOR[m.type]}>{TYPE_LABEL[m.type] || m.type}</b></span>
          {producto && <span>Producto: <b>{producto.code} — {producto.name}</b></span>}
          <span>Usuario: <b>{m.usuario || '—'}</b></span>
        </div>
        <div className="px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-3 text-sm">
          <Dato label="Documento" value={doc ? docLabel : '—'} />
          <Dato label="Tercero / motivo" value={m.tercero || m.motivo || '—'} />
          <Dato label="Bodega origen" value={m.warehouse ? `${m.warehouse.code} — ${m.warehouse.name}` : '—'} />
          <Dato label="Bodega destino" value={m.toWarehouse ? `${m.toWarehouse.code} — ${m.toWarehouse.name}` : '—'} />
          <Dato label="Lote" value={m.lot || '—'} />
          <Dato label="Vencimiento" value={m.expiryDate ? fmtDate(m.expiryDate) : '—'} />
          <Dato label="Entrada (u)" value={m.entradaQty || '—'} color="text-emerald-700" mono />
          <Dato label="Salida (u)" value={m.salidaQty || '—'} color="text-rose-600" mono />
          {conCostos && <Dato label="Costo unitario" value={fmt(m.unitCost)} mono />}
          {conCostos && <Dato label="Valor entrada" value={m.entradaValor ? fmt(m.entradaValor) : '—'} color="text-emerald-700" mono />}
          {conCostos && <Dato label="Valor salida" value={m.salidaValor ? fmt(m.salidaValor) : '—'} color="text-rose-600" mono />}
          <Dato label="Saldo (u)" value={m.saldoQty} mono />
          {conCostos && <Dato label="Saldo ($)" value={fmt(m.saldoValor)} mono />}
          {conCostos && <Dato label="Costo promedio" value={fmt(m.costoPromedio)} mono />}
        </div>

        {/* Consumo FIFO de capas (de dónde salió el costo real de una salida) */}
        {conCostos && m.layerConsumption?.length > 0 && (
          <div className="px-4 pb-3">
            <p className="text-[11px] uppercase tracking-wide text-slate-400 mb-1">Consumo de capas (FIFO)</p>
            <div className="flex flex-wrap gap-1.5">
              {m.layerConsumption.map((c, i) => (
                <span key={i} className="text-[11px] font-mono bg-slate-100 text-slate-600 rounded px-2 py-0.5">
                  {c.qty} u × {fmt(c.unitCost)}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sub-modales apilados (Escape cierra primero el de arriba). */}
      <JournalEntryViewModal
        isOpen={verAsiento}
        onClose={() => setVerAsiento(false)}
        source={doc ? { model: doc.model, ref: doc.ref } : null}
        entryId={doc ? null : m.journalEntry}
        title="Movimiento contable (asiento)"
        emptyHint="Para las ventas, el costo de venta y la salida de inventario van en el mismo asiento de la venta."
      />
      <DocumentPreviewModal
        isOpen={verFactura}
        onClose={() => setVerFactura(false)}
        model={doc?.model}
        id={doc?.ref}
        title={hayFactura ? `${docLabel} (solo consulta)` : 'Factura'}
      />
    </Modal>
  );
}

/** Tarjeta de acceso de consulta. Sin `onClick` = deshabilitada (no hay qué abrir). */
function Acceso({ icon: Icon, color, titulo, detalle, onClick, activo = false }) {
  const activa = activo;
  const clickable = !!onClick;
  const base = 'text-left rounded-xl border p-3 h-full flex flex-col gap-1 transition-colors';
  const estilo = activa
    ? 'border-emerald-300 bg-emerald-50'
    : clickable
      ? 'border-slate-200 bg-white hover:bg-slate-50 cursor-pointer'
      : 'border-slate-100 bg-slate-50 opacity-60 cursor-default';
  const Tag = clickable ? 'button' : 'div';
  const tint = {
    emerald: 'text-emerald-600', indigo: 'text-indigo-600', amber: 'text-amber-600',
  }[color] || 'text-slate-500';
  return (
    <Tag type={clickable ? 'button' : undefined} onClick={onClick || undefined} className={`${base} ${estilo}`}>
      <span className="flex items-center gap-2">
        <Icon className={`w-5 h-5 ${tint}`} />
        <span className="font-semibold text-sm text-slate-800">{titulo}</span>
        {clickable && <HiOutlineArrowRight className="w-4 h-4 text-slate-300 ml-auto" />}
      </span>
      <span className="text-[11px] text-slate-500 leading-snug">{detalle}</span>
      {activa && <span className="text-[10px] font-bold text-emerald-700 mt-auto">EN PANTALLA</span>}
    </Tag>
  );
}

function Dato({ label, value, color = 'text-slate-800', mono = false }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`${color} ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}
