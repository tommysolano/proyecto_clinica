const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateSaleLine, summarizeSaleTaxes } = require('../utils/tax');

test('separates VAT from a price that already includes VAT', () => {
  const line = calculateSaleLine({
    product: {
      name: 'Producto gravado',
      salePrice: 115,
      taxRate: 15,
      taxCategory: 'IVA_15',
      priceIncludesVat: true,
    },
    quantity: 1,
  });

  assert.equal(line.taxBase, 100);
  assert.equal(line.taxAmount, 15);
  assert.equal(line.lineTotal, 115);
  assert.equal(line.taxCodeSri, '4');
});

test('keeps medical services at zero VAT', () => {
  const line = calculateSaleLine({
    product: {
      name: 'Consulta medica',
      category: 'servicio',
      salePrice: 50,
      taxCategory: 'IVA_0',
      priceIncludesVat: true,
    },
    quantity: 2,
  });

  assert.equal(line.taxBase, 100);
  assert.equal(line.taxAmount, 0);
  assert.equal(line.lineTotal, 100);
  assert.equal(line.taxCodeSri, '0');
});

test('applies discounts before calculating VAT', () => {
  const line = calculateSaleLine({
    product: {
      name: 'Producto gravado',
      salePrice: 115,
      taxRate: 15,
      taxCategory: 'IVA_15',
      priceIncludesVat: true,
    },
    quantity: 1,
    discount: 11.5,
  });

  assert.equal(line.taxBase, 90);
  assert.equal(line.taxAmount, 13.5);
  assert.equal(line.lineTotal, 103.5);
  assert.equal(line.discountTaxBase, 10);
});

test('summarizes mixed tax treatments', () => {
  const lines = [
    calculateSaleLine({
      product: { salePrice: 115, taxRate: 15, taxCategory: 'IVA_15', priceIncludesVat: true },
      quantity: 1,
    }),
    calculateSaleLine({
      product: { salePrice: 30, taxCategory: 'IVA_0', priceIncludesVat: true },
      quantity: 1,
    }),
  ];

  const totals = summarizeSaleTaxes(lines);
  assert.equal(totals.taxableSubtotal, 130);
  assert.equal(totals.subtotal0, 30);
  assert.equal(totals.taxAmount, 15);
  assert.equal(totals.total, 145);
});
