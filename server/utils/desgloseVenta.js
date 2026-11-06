/**
 * DESGLOSE TRIBUTARIO DE UNA VENTA PARA LOS REPORTES (nov-2026).
 *
 * `Sale.subtotal` NO es el subtotal de la factura: es la suma de los precios visibles
 * (con el IVA dentro cuando el precio lo incluye, y antes del descuento). Los Excel lo
 * mostraban como «Subtotal» y la contadora veía Subtotal 110,50 + IVA 14,41 = Total 110,50.
 * Lo que va en un reporte es lo de la factura del SRI:
 *
 *   base0 + base15 + base5 + baseOtraTarifa + exento + noObjeto = subtotal (sin impuestos)
 *   subtotal + iva = total
 *   descuento: el de la factura (sobre la base, sin IVA), informativo — las bases ya lo restan.
 *
 * Se calcula por LÍNEAS (cada una trae su tarifa y su base): las ventas importadas de
 * Contífico tienen los totales de cabecera incompletos (`taxableSubtotal` en 0), pero sus
 * líneas sí cuadran con el mayor.
 */
const { breakdownFromSale } = require('./invoiceTaxBreakdown');

const r2 = (n) => +(Number(n) || 0).toFixed(2);

function desgloseVenta(sale = {}) {
  const items = Array.isArray(sale.items) ? sale.items : [];
  const b = breakdownFromSale(sale);
  const porTarifa = (tasa) => r2((b.rates || [])
    .filter((r) => Number(r.rate) === tasa && !['6', '7'].includes(String(r.codigoPorcentaje)))
    .reduce((s, r) => s + r.base, 0));
  const base15 = porTarifa(15);
  const base5 = porTarifa(5);
  // Tarifas históricas (12 %, 13 %, 14 %): no se pierden, van en su propia columna.
  const baseOtraTarifa = r2(b.baseGravada - base15 - base5);
  const descuento = items.length
    ? r2(items.reduce((s, it) => s + Number(it.discountTaxBase ?? it.discount ?? 0), 0))
    : r2(sale.discountTaxBase ?? sale.discountTotal ?? 0);
  const total = r2(sale.total);
  const iva = r2(sale.taxAmount ?? b.iva);
  return {
    base0: b.base0,
    base15,
    base5,
    baseOtraTarifa: Math.abs(baseOtraTarifa) < 0.005 ? 0 : baseOtraTarifa,
    exento: b.baseExento,
    noObjeto: b.baseNoObjeto,
    // Sin impuestos = total − IVA: cuadra siempre con el total de la venta.
    subtotal: r2(total - iva),
    descuento,
    iva,
    total,
  };
}

/** Número de factura «001-002-000001234», con el secuencial completo a 9 dígitos. */
function numeroFactura(invoice) {
  if (!invoice || !invoice.secuencial) return '';
  return `${invoice.estab}-${invoice.ptoEmi}-${String(invoice.secuencial).padStart(9, '0')}`;
}

/**
 * Lo que identifica la venta en la primera columna: su factura. Las importadas de
 * Contífico ya traen el número de factura como número de venta. Sin factura se dice.
 */
function facturaDeVenta(sale, invoice) {
  const n = numeroFactura(invoice || (sale?.invoice?.secuencial ? sale.invoice : null));
  if (n) return n;
  if (/^\d{3}-\d{3}-\d{9}$/.test(String(sale?.saleNumber || ''))) return sale.saleNumber;
  return `Sin factura (${sale?.saleNumber || '—'})`;
}

/** Columnas del desglose, en el orden en que las lee el contador. */
const COLUMNAS_DESGLOSE = [
  { header: 'Subtotal 0%', key: 'base0', width: 13 },
  { header: 'Subtotal 15%', key: 'base15', width: 13 },
  { header: 'Subtotal 5%', key: 'base5', width: 12 },
  { header: 'Subtotal otra tarifa', key: 'baseOtraTarifa', width: 14 },
  { header: 'Exento de IVA', key: 'exento', width: 13 },
  { header: 'No objeto de IVA', key: 'noObjeto', width: 14 },
  { header: 'Descuento', key: 'descuento', width: 12 },
  { header: 'Subtotal sin impuestos', key: 'subtotal', width: 16 },
  { header: 'IVA', key: 'iva', width: 11 },
  { header: 'Total', key: 'total', width: 12 },
];
const CLAVES_DESGLOSE = COLUMNAS_DESGLOSE.map((c) => c.key);

module.exports = { desgloseVenta, numeroFactura, facturaDeVenta, COLUMNAS_DESGLOSE, CLAVES_DESGLOSE };
