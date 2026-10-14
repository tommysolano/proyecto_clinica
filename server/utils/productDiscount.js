/**
 * DESCUENTO DEL PRODUCTO (oct-2026). Los descuentos ya no se teclean al cobrar:
 * se configuran en el inventario, en el propio producto, y el servidor los
 * aplica solo en cada venta. La factura los lleva por línea (`descuento` del
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

module.exports = { descuentoDeLinea };
