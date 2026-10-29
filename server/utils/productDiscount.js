/**
 * DESCUENTO DEL PRODUCTO (oct-2026). Se configura en el inventario, en el propio
 * producto, y es el que viene puesto en cada línea al cobrar (desde el 29-10-2026
 * el cajero lo puede cambiar: ver `descuentoAlCobrar`). La factura los lleva por línea (`descuento` del
 * detalle SRI) igual que antes.
 *
 *   discountType 'percentage' → % sobre el importe de la línea (precio × cantidad)
 *   discountType 'amount'     → $ por unidad (con el IVA incluido si el precio lo incluye)
 *
 * Nunca pasa del importe de la línea. Espejo en client/src/pages/Sales.jsx
 * (`descuentoDeLinea`): si cambias uno, cambia el otro.
 */
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

function descuentoDeLinea(product, unitPrice, quantity) {
  const valor = Number(product?.discountValue) || 0;
  if (!product?.discountType || valor <= 0) return 0;
  const bruto = r2(Number(unitPrice || 0) * Number(quantity || 0));
  if (bruto <= 0) return 0;
  const d = product.discountType === 'percentage'
    ? r2(bruto * Math.min(valor, 100) / 100)
    : product.discountType === 'amount'
      ? r2(valor * Number(quantity || 0))
      : 0;
  return Math.min(d, bruto);
}

/**
 * DESCUENTO AL COBRAR (29-10-2026, vuelve a pedido de la clínica). El cajero puede
 * cambiar el descuento de cada línea: `manual` es el importe en $ que tecleó (null o
 * vacío = no lo tocó y vale el del producto). Nunca negativo ni más que la línea.
 * `cambiado` dice si difiere del del producto: entonces la venta exige el motivo.
 */
function descuentoAlCobrar(product, unitPrice, quantity, manual) {
  const delProducto = descuentoDeLinea(product, unitPrice, quantity);
  if (manual === undefined || manual === null || manual === '' || !Number.isFinite(Number(manual))) {
    return { discount: delProducto, cambiado: false };
  }
  const bruto = Math.max(r2(Number(unitPrice || 0) * Number(quantity || 0)), 0);
  const discount = Math.min(Math.max(r2(manual), 0), bruto);
  return { discount, cambiado: Math.abs(discount - delProducto) > 0.005 };
}

module.exports = { descuentoDeLinea, descuentoAlCobrar };
