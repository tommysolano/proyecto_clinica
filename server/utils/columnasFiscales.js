/**
 * COLUMNAS FISCALES ÚNICAS PARA LOS EXCEL (nov-2026, pedido del contador):
 * «cualquier consulta debe clasificar correctamente Base 0%, Base 15%, No objeto de IVA,
 * Base 5%, Subtotal, IVA, Total». Antes cada reporte traía su propio corte (unos solo
 * «Base 0% / Base 15%», otros solo «Subtotal»), y una línea al 5% o no objeto quedaba
 * escondida dentro de otra columna.
 *
 *   const { COLUMNAS_FISCALES, fiscalDeVenta, fiscalDeCompra } = require('../utils/columnasFiscales');
 *   columns: [..., ...COLUMNAS_FISCALES]
 *   rows:    ventas.map((v) => ({ ..., ...fiscalDeVenta(v) }))
 *
 * Subtotal = suma de las bases (sin IVA). Total = Subtotal + IVA (lo del documento).
 * La tarifa histórica del 12% (derogada) se suma en la columna «Base 15%».
 */
const { invoiceTaxBreakdown } = require('./invoiceTaxBreakdown');

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

const COLUMNAS_FISCALES = [
  { header: 'Base 0%', key: 'base0', width: 13, money: true },
  { header: 'Base 5%', key: 'base5', width: 13, money: true },
  { header: 'Base 15%', key: 'base15', width: 13, money: true },
  { header: 'No objeto de IVA', key: 'baseNoObjeto', width: 15, money: true },
  { header: 'Exento de IVA', key: 'baseExento', width: 14, money: true },
  { header: 'Subtotal', key: 'subtotal', width: 14, money: true },
  { header: 'IVA', key: 'iva', width: 12, money: true },
  { header: 'Total', key: 'total', width: 14, money: true },
];

/** Reparte la base gravada entre 5% y 15% según el detalle por tarifa del documento. */
function repartirGravada(baseGravada, iva, rates) {
  let base5 = 0;
  let base15 = 0;
  const lista = Array.isArray(rates) ? rates.filter((r) => Number(r.rate) > 0) : [];
  if (lista.length) {
    for (const r of lista) {
      if (Number(r.rate) === 5) base5 += Number(r.base) || 0;
      else base15 += Number(r.base) || 0;
    }
  } else if (baseGravada > 0) {
    // Sin detalle por tarifa: se deduce de la proporción IVA / base.
    const tasa = iva / baseGravada;
    if (Math.abs(tasa - 0.05) < 0.01) base5 = baseGravada; else base15 = baseGravada;
  }
  return { base5: r2(base5), base15: r2(base15) };
}

/** Desglose de una venta o de su factura electrónica (acepta Invoice o Sale con `taxBreakdown`). */
function fiscalDeVenta(doc) {
  const tb = doc?.taxBreakdown && (doc.taxBreakdown.base0 != null || doc.taxBreakdown.baseGravada != null)
    ? doc.taxBreakdown
    : invoiceTaxBreakdown(doc || {});
  const base0 = r2(tb.base0);
  const baseNoObjeto = r2(tb.baseNoObjeto);
  const baseExento = r2(tb.baseExento);
  const iva = r2(tb.iva ?? doc?.totalImpuesto ?? doc?.taxAmount);
  const { base5, base15 } = repartirGravada(Number(tb.baseGravada) || 0, iva, tb.rates);
  const subtotal = r2(base0 + base5 + base15 + baseNoObjeto + baseExento);
  const total = r2(doc?.importeTotal ?? doc?.total ?? subtotal + iva);
  return { base0, base5, base15, baseNoObjeto, baseExento, subtotal, iva, total };
}

/** Desglose de una factura de compra (campos subtotal0/5/12/15/NoObjeto/Exento del modelo). */
function fiscalDeCompra(p) {
  const base0 = r2(p?.subtotal0);
  const base5 = r2(p?.subtotal5);
  const base15 = r2((Number(p?.subtotal15) || 0) + (Number(p?.subtotal12) || 0));
  const baseNoObjeto = r2(p?.subtotalNoObjeto);
  const baseExento = r2(p?.subtotalExento);
  let subtotal = r2(base0 + base5 + base15 + baseNoObjeto + baseExento);
  // Compras antiguas sin bases separadas: el subtotal del documento va como base 0% si no
  // tiene IVA, o como 15% si lo tiene, para que la fila cuadre con su total.
  const out = { base0, base5, base15, baseNoObjeto, baseExento };
  const iva = r2(p?.iva);
  if (!subtotal && Number(p?.subtotal)) {
    if (iva > 0) out.base15 = r2(p.subtotal); else out.base0 = r2(p.subtotal);
    subtotal = r2(p.subtotal);
  }
  return { ...out, subtotal, iva, total: r2(p?.total ?? subtotal + iva) };
}

module.exports = { COLUMNAS_FISCALES, fiscalDeVenta, fiscalDeCompra };
