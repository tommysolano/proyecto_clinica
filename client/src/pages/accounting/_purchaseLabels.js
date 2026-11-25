// Etiquetas y estado de pago de las COMPRAS: los comparten la lista (PurchaseInvoices) y la
// página de detalle (PurchaseInvoiceDetail).

/**
 * Estado de PAGO de una factura de compra (abonado / saldo / etiqueta).
 *
 * Antes la lista solo mostraba REGISTRADA o PAGADA: una factura de $300 con un abono de $50 se
 * veía idéntica a una intacta. Aquí se deriva lo que falta:
 *
 *     neto a pagar = total − retenciones     (la retención no se le paga al proveedor)
 *     abonado      = neto − saldo
 *
 * `balance` es el saldo que mantiene el backend en cada pago. Un abono parcial ⇒ "ABONADA".
 */
export const payStatus = (p) => {
  const neto = +(Number(p.total || 0) - Number(p.retentionTotal || 0)).toFixed(2);
  const saldo = +Number(p.balance ?? neto).toFixed(2);
  const abonado = +Math.max(0, neto - saldo).toFixed(2);
  const parcial = p.status === 'REGISTRADA' && abonado > 0.005 && saldo > 0.005;
  const label = p.status === 'POR_AUTORIZAR' ? 'POR CONTABILIZAR' : parcial ? 'ABONADA' : p.status;
  const badgeClass = p.status === 'POR_AUTORIZAR' ? 'bg-amber-100 text-amber-700'
    : p.status === 'ANULADA' ? 'bg-rose-100 text-rose-700'
    : p.status === 'PAGADA' ? 'bg-sky-100 text-sky-700'
    : parcial ? 'bg-indigo-100 text-indigo-700'
    : 'bg-emerald-100 text-emerald-700';
  return { neto, saldo, abonado, parcial, label, badgeClass };
};

export const PAY_METHOD_LABEL = { EFECTIVO: 'Efectivo', TRANSFERENCIA: 'Transferencia', CHEQUE: 'Cheque', TARJETA: 'Tarjeta', DEPOSITO: 'Depósito', OTRO: 'Otro' };

// El tipo de comprobante va como subtítulo de la serie (no como columna propia):
// en el 95 % de las filas dice «FACTURA» y solo gastaba ancho.
export const DOC_TYPE_LABEL = {
  FACTURA: 'Factura', NOTA_VENTA: 'Nota de venta', LIQUIDACION: 'Liquidación de compra',
  NOTA_DEBITO_REC: 'Nota de débito', NOTA_CREDITO_REC: 'Nota de crédito',
  ANTICIPO_PROVEEDOR: 'Anticipo a proveedor', NO_AUTORIZADO: 'Documento no autorizado',
};

// Estados en los que una compra ya contabilizada admite corrección. Que esté PAGADA
// no la vuelve intocable: los abonos se conservan y el saldo se recalcula. Lo que sí
// la congela es haber emitido el comprobante de retención (documento fiscal del SRI).
export const CORREGIBLES = ['REGISTRADA', 'PAGADA'];
export const retencionEmitida = (p) => !!p?.retentionVoucher || !!String(p?.retentionNumber || '').trim();
