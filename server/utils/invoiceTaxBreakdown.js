/**
 * Desglose tributario de VENTAS por tarifa de IVA.
 *
 * Los reportes SRI (F104, ATS) y la conciliación contable necesitan separar las
 * ventas por tarifa (0% vs gravada 15%), no solo la base total y el IVA total.
 * La VENTA (Sale) ya calcula ese desglose (subtotal0/taxableSubtotal/…/taxAmount y
 * los ítems con taxCategory/taxRate/taxBase/taxAmount). Este módulo:
 *   1) deriva ese desglose desde una Sale o desde ítems (breakdownFromSale), para
 *      guardarlo como SNAPSHOT en la factura al emitir;
 *   2) lee el desglose desde una factura (invoiceTaxBreakdown), usando el snapshot
 *      si existe y, si no (facturas antiguas), un fallback seguro por totales.
 *
 * Forma normalizada devuelta:
 *   base0        base tarifa 0%
 *   baseGravada  base con IVA (>0%, típicamente 15%)
 *   baseExento   base exenta
 *   baseNoObjeto base no objeto de IVA
 *   iva          IVA generado sobre la base gravada
 *   baseTotal    base0 + baseGravada + baseExento + baseNoObjeto (= totalSinImpuestos)
 *   rates        detalle por tarifa: [{ codigoPorcentaje, rate, base, iva }]
 *   derived      true si se estimó por fallback (factura sin snapshot)
 */
const { round2, sriVatCode } = require('./tax');

function normalize(b) {
  const base0 = round2(b.base0);
  const baseGravada = round2(b.baseGravada);
  const baseExento = round2(b.baseExento);
  const baseNoObjeto = round2(b.baseNoObjeto);
  const iva = round2(b.iva);
  return {
    base0,
    baseGravada,
    baseExento,
    baseNoObjeto,
    iva,
    baseTotal: round2(base0 + baseGravada + baseExento + baseNoObjeto),
    rates: Array.isArray(b.rates)
      ? b.rates.map((r) => ({
          codigoPorcentaje: String(r.codigoPorcentaje || '0'),
          rate: Number(r.rate) || 0,
          base: round2(r.base),
          iva: round2(r.iva),
        }))
      : [],
    derived: Boolean(b.derived),
  };
}

const ZERO = () => normalize({ base0: 0, baseGravada: 0, baseExento: 0, baseNoObjeto: 0, iva: 0 });

/** Desglose por tarifa a partir de ítems de venta (Sale.items o snapshot equivalente). */
function breakdownFromItems(items) {
  const acc = { base0: 0, baseGravada: 0, baseExento: 0, baseNoObjeto: 0, iva: 0 };
  const ratesMap = new Map();
  for (const it of items || []) {
    const base = Number(it.taxBase ?? it.subtotal ?? 0);
    const ivaAmt = Number(it.taxAmount ?? 0);
    const rate = Number(it.taxRate ?? (ivaAmt > 0 ? 15 : 0));
    const cat = it.taxCategory;
    const code = it.taxCodeSri || sriVatCode(cat, rate);
    if (cat === 'NO_OBJETO' || code === '6') acc.baseNoObjeto += base;
    else if (cat === 'EXENTO' || code === '7') acc.baseExento += base;
    else if (rate > 0) {
      acc.baseGravada += base;
      acc.iva += ivaAmt;
    } else acc.base0 += base;
    const r = ratesMap.get(code) || { codigoPorcentaje: code, rate, base: 0, iva: 0 };
    r.base += base;
    r.iva += ivaAmt;
    ratesMap.set(code, r);
  }
  return normalize({ ...acc, rates: [...ratesMap.values()], derived: false });
}

/**
 * Desglose desde una Sale. Prefiere sumar por ÍTEMS (fuente granular con tarifa por
 * línea); si no hay ítems, usa los totales que la venta ya resumió. Ojo: en la Sale,
 * `taxableSubtotal` es la suma de TODAS las bases (gravada + 0% + exento + no objeto),
 * así que la base gravada se obtiene restando las otras.
 */
function breakdownFromSale(sale) {
  if (!sale) return ZERO();
  if (Array.isArray(sale.items) && sale.items.length) return breakdownFromItems(sale.items);
  const base0 = Number(sale.subtotal0 || 0);
  const baseExento = Number(sale.subtotalExento || 0);
  const baseNoObjeto = Number(sale.subtotalNoObjeto || 0);
  const baseTotal = Number(sale.taxableSubtotal || 0);
  const baseGravada = baseTotal - base0 - baseExento - baseNoObjeto;
  return normalize({ base0, baseGravada, baseExento, baseNoObjeto, iva: Number(sale.taxAmount || 0), derived: false });
}

function hasSnapshot(tb) {
  return !!tb && (tb.computed || tb.base0 || tb.baseGravada || tb.baseExento || tb.baseNoObjeto || tb.iva);
}

/**
 * Desglose de una factura de VENTA (Invoice):
 *  - si trae SNAPSHOT `taxBreakdown` (facturas nuevas), lo usa tal cual;
 *  - si no (facturas antiguas), lo DERIVA de los totales agregados con un fallback
 *    seguro: IVA>0 ⇒ toda la base se asume gravada; IVA=0 ⇒ toda la base se asume 0%.
 *    Es exacto salvo para facturas MIXTAS antiguas (0% + 15% en el mismo comprobante),
 *    que no pueden separarse sin los ítems; para esas conviene correr el backfill
 *    (scripts/backfillInvoiceTaxBreakdown.js) que recalcula desde la venta origen.
 */
function invoiceTaxBreakdown(invoice) {
  const tb = invoice && invoice.taxBreakdown;
  if (hasSnapshot(tb)) {
    return normalize({
      base0: tb.base0,
      baseGravada: tb.baseGravada,
      baseExento: tb.baseExento,
      baseNoObjeto: tb.baseNoObjeto,
      iva: tb.iva,
      rates: tb.rates,
      derived: false,
    });
  }
  const baseTotal = Number(invoice?.totalSinImpuestos || 0);
  const iva = Number(invoice?.totalImpuesto || 0);
  if (iva > 0) return normalize({ base0: 0, baseGravada: baseTotal, baseExento: 0, baseNoObjeto: 0, iva, derived: true });
  return normalize({ base0: baseTotal, baseGravada: 0, baseExento: 0, baseNoObjeto: 0, iva: 0, derived: true });
}

module.exports = { breakdownFromSale, breakdownFromItems, invoiceTaxBreakdown };
