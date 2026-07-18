import { useEffect, useState } from 'react';
import api from '../api/axios';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { fmt, fmtDate } from '../pages/accounting/_utils';

/**
 * Visor de SOLO LECTURA de una factura de origen (venta o compra), reutilizable desde
 * cualquier módulo (hoy: el kardex). NO navega al formulario editable: es una consulta.
 * Muestra la cabecera (número, fecha, tercero), las líneas y los totales/impuestos.
 *
 * Props: { isOpen, onClose, model: 'Sale' | 'PurchaseInvoice', id, title }
 *
 * La normalización vive aquí porque venta y compra tienen formas distintas: así el
 * componente presenta una sola estructura y el resto del sistema no tiene que conocerlas.
 */

const ENDPOINT = { Sale: '/sales', PurchaseInvoice: '/purchase-invoices' };

/** Venta o compra → una estructura común de presentación. */
function normalize(model, doc) {
  if (model === 'PurchaseInvoice') {
    return {
      tipo: 'Factura de compra',
      numero: doc.serie || [doc.estab, doc.ptoEmi, doc.secuencial].filter(Boolean).join('-') || '—',
      fecha: doc.fechaEmision,
      terceroLabel: 'Proveedor',
      tercero: doc.supplier?.razonSocial || doc.supplier?.name || doc.proveedorNombre || '—',
      terceroId: doc.supplier?.ruc || doc.supplier?.identificacion || '',
      estado: doc.status,
      lineas: (doc.items || []).map((it) => ({
        nombre: it.product?.name || it.description || '—',
        codigo: it.product?.code || '',
        cantidad: it.quantity,
        precio: it.unitPrice,
        subtotal: it.subtotal,
        ivaRate: it.ivaRate,
        ivaAmount: it.ivaAmount,
      })),
      totales: { subtotal: doc.subtotal, descuento: null, iva: doc.iva, total: doc.total },
    };
  }
  // Sale
  const paciente = doc.patient ? `${doc.patient.firstName || ''} ${doc.patient.lastName || ''}`.trim() : '';
  return {
    tipo: 'Venta',
    numero: doc.saleNumber || '—',
    fecha: doc.createdAt,
    terceroLabel: 'Cliente',
    tercero: doc.clientName || paciente || '—',
    terceroId: doc.clientCedula || doc.patient?.cedula || '',
    estado: doc.status,
    lineas: (doc.items || []).map((it) => ({
      nombre: it.product?.name || it.productName || '—',
      codigo: it.product?.code || '',
      cantidad: it.quantity,
      precio: it.unitPrice,
      subtotal: it.subtotal,
      ivaRate: null,
      ivaAmount: it.taxAmount,
    })),
    totales: { subtotal: doc.subtotal, descuento: doc.discountTotal, iva: doc.taxAmount, total: doc.total },
  };
}

export default function DocumentPreviewModal({ isOpen, onClose, model, id, title }) {
  const [doc, setDoc] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || !model || !id || !ENDPOINT[model]) { setDoc(null); return; }
    let vivo = true;
    setLoading(true);
    setDoc(null);
    api.get(`${ENDPOINT[model]}/${id}`)
      .then((r) => { if (vivo) setDoc({ model, ...normalize(model, r.data) }); })
      .catch((e) => toast.error(e.response?.data?.message || 'No se pudo cargar la factura'))
      .finally(() => { if (vivo) setLoading(false); });
    return () => { vivo = false; };
  }, [isOpen, model, id]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={title || 'Factura (solo consulta)'} size="xl">
      {loading && <div className="text-center text-slate-500 py-8">Cargando factura…</div>}

      {!loading && !ENDPOINT[model] && (
        <div className="text-center py-8 text-slate-500 text-sm">Este origen no es una factura consultable.</div>
      )}

      {!loading && doc && (
        <div className="space-y-4">
          {/* Cabecera */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 grid grid-cols-2 sm:grid-cols-4 gap-x-4 gap-y-2 text-sm">
            <Item label="Tipo" value={doc.tipo} />
            <Item label="Número" value={doc.numero} mono />
            <Item label="Fecha" value={fmtDate(doc.fecha)} />
            <Item label="Estado" value={doc.estado || '—'} />
            <Item label={doc.terceroLabel} value={doc.tercero} className="sm:col-span-2" />
            <Item label="Identificación" value={doc.terceroId || '—'} mono className="sm:col-span-2" />
          </div>

          {/* Líneas */}
          <div className="border border-slate-200 rounded-xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 text-xs uppercase text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Código</th>
                    <th className="px-3 py-2 text-left">Producto / detalle</th>
                    <th className="px-3 py-2 text-right">Cant.</th>
                    <th className="px-3 py-2 text-right">P. unit.</th>
                    <th className="px-3 py-2 text-right">Subtotal</th>
                    <th className="px-3 py-2 text-right">IVA</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.lineas.map((l, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono text-xs text-slate-500">{l.codigo || '—'}</td>
                      <td className="px-3 py-2">{l.nombre}</td>
                      <td className="px-3 py-2 text-right font-mono">{l.cantidad}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(l.precio)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(l.subtotal)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">
                        {l.ivaRate != null ? `${l.ivaRate}% · ` : ''}{fmt(l.ivaAmount)}
                      </td>
                    </tr>
                  ))}
                  {!doc.lineas.length && (
                    <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-400">Sin líneas</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Totales */}
          <div className="flex justify-end">
            <div className="w-full sm:w-72 space-y-1 text-sm">
              <Total label="Subtotal" value={doc.totales.subtotal} />
              {doc.totales.descuento ? <Total label="Descuento" value={doc.totales.descuento} /> : null}
              <Total label="IVA" value={doc.totales.iva} />
              <Total label="Total" value={doc.totales.total} bold />
            </div>
          </div>

          <p className="text-[11px] text-slate-400 text-center">Vista de consulta · solo lectura</p>
        </div>
      )}
    </Modal>
  );
}

function Item({ label, value, mono = false, className = '' }) {
  return (
    <div className={className}>
      <p className="text-[11px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-slate-800 ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  );
}

function Total({ label, value, bold = false }) {
  return (
    <div className={`flex justify-between px-3 py-1.5 rounded-lg ${bold ? 'bg-slate-100 font-bold text-slate-800' : 'text-slate-600'}`}>
      <span>{label}</span>
      <span className="font-mono">{fmt(value)}</span>
    </div>
  );
}
