function round2(value) {
  return +Number(value || 0).toFixed(2);
}

function normalizeRate(rate) {
  const n = Number(rate);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n <= 1 ? n * 100 : n;
}

function inferTaxCategory(product = {}) {
  if (product.taxCategory) return product.taxCategory;
  if (product.isMedicalService || product.category === 'servicio') return 'IVA_0';
  return 'IVA_15';
}

function categoryRate(category, productRate, defaultVatRate = 15) {
  if (['IVA_0', 'EXENTO', 'NO_OBJETO'].includes(category)) return 0;
  if (category === 'IVA_5') return 5;     // tarifa vigente para sectores específicos
  if (category === 'IVA_12') return 12;   // derogada; solo documentos históricos
  if (category === 'IVA_15') return normalizeRate(productRate || defaultVatRate || 15);
  return normalizeRate(productRate || 0);
}

/**
 * Código de tarifa de IVA del SRI (tabla 16 de la ficha técnica):
 *   0 → 0 %, 2 → 12 %, 3 → 14 %, 4 → 15 %, 5 → 5 %, 6 → no objeto, 7 → exento, 10 → 13 %.
 * El 5 % faltaba: una venta al 5 % se firmaba con código 0 y el SRI la liquidaba como exenta.
 */
function sriVatCode(category, rate, explicitCode) {
  if (explicitCode) return String(explicitCode);
  if (category === 'NO_OBJETO') return '6';
  if (category === 'EXENTO') return '7';
  if (rate === 5) return '5';
  if (rate === 12) return '2';
  if (rate === 13) return '10';
  if (rate === 14) return '3';
  if (rate === 15) return '4';
  return '0';
}

function calculateSaleLine({ product, quantity, unitPrice, discount = 0, priceIncludesVat, defaultVatRate = 15 }) {
  const qty = Number(quantity);
  if (!qty || qty <= 0) {
    throw Object.assign(new Error(`Cantidad invalida para ${product?.name || 'item'}`), { status: 400 });
  }

  const category = inferTaxCategory(product);
  const rate = categoryRate(category, product?.taxRate, defaultVatRate);
  const includesVat = priceIncludesVat !== undefined
    ? Boolean(priceIncludesVat)
    : product?.priceIncludesVat !== false;
  const visibleUnitPrice = Number(unitPrice ?? product?.salePrice ?? 0);
  const rawAmount = round2(visibleUnitPrice * qty);
  const rawDiscount = round2(discount);
  if (rawDiscount < 0) throw Object.assign(new Error('Descuento negativo no permitido'), { status: 400 });
  if (rawDiscount > rawAmount + 0.01) {
    throw Object.assign(new Error(`El descuento excede el valor de ${product?.name || 'item'}`), { status: 400 });
  }

  const factor = 1 + rate / 100;
  let taxBase;
  let taxAmount;
  let lineTotal;
  let unitPriceExcludingTax;
  let discountTaxBase;

  if (includesVat && rate > 0) {
    const grossAfterDiscount = round2(rawAmount - rawDiscount);
    taxBase = round2(grossAfterDiscount / factor);
    taxAmount = round2(grossAfterDiscount - taxBase);
    lineTotal = grossAfterDiscount;
    unitPriceExcludingTax = round2(visibleUnitPrice / factor);
    discountTaxBase = round2(rawDiscount / factor);
  } else {
    taxBase = round2(rawAmount - rawDiscount);
    taxAmount = round2(taxBase * (rate / 100));
    lineTotal = round2(taxBase + taxAmount);
    unitPriceExcludingTax = visibleUnitPrice;
    discountTaxBase = rawDiscount;
  }

  return {
    quantity: qty,
    unitPrice: round2(visibleUnitPrice),
    unitPriceExcludingTax,
    grossAmount: rawAmount,
    discount: rawDiscount,
    discountTaxBase,
    taxCategory: category,
    taxRate: rate,
    taxCodeSri: sriVatCode(category, rate, product?.taxCodeSri),
    priceIncludesVat: includesVat,
    taxBase,
    taxAmount,
    lineTotal,
  };
}

function summarizeSaleTaxes(lines) {
  return (lines || []).reduce((acc, line) => {
    acc.visibleSubtotal = round2(acc.visibleSubtotal + Number(line.grossAmount || 0));
    acc.discountTotal = round2(acc.discountTotal + Number(line.discount || 0));
    acc.discountTaxBase = round2(acc.discountTaxBase + Number(line.discountTaxBase || 0));
    acc.taxableSubtotal = round2(acc.taxableSubtotal + Number(line.taxBase || 0));
    acc.taxAmount = round2(acc.taxAmount + Number(line.taxAmount || 0));
    acc.total = round2(acc.total + Number(line.lineTotal || 0));
    if (line.taxCategory === 'NO_OBJETO') acc.subtotalNoObjeto = round2(acc.subtotalNoObjeto + Number(line.taxBase || 0));
    else if (line.taxCategory === 'EXENTO') acc.subtotalExento = round2(acc.subtotalExento + Number(line.taxBase || 0));
    else if (Number(line.taxRate || 0) === 0) acc.subtotal0 = round2(acc.subtotal0 + Number(line.taxBase || 0));
    return acc;
  }, {
    visibleSubtotal: 0,
    discountTotal: 0,
    discountTaxBase: 0,
    taxableSubtotal: 0,
    subtotal0: 0,
    subtotalExento: 0,
    subtotalNoObjeto: 0,
    taxAmount: 0,
    total: 0,
  });
}

module.exports = {
  calculateSaleLine,
  summarizeSaleTaxes,
  sriVatCode,
  round2,
};
