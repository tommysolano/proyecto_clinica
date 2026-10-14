/**
 * PVP con IVA de un producto de Contífico (pvp1 es la base). Al cobrarlo con el precio con IVA
 * incluido, la base y el IVA tienen que salir iguales a los de la factura de Contífico.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { pvpConIva } = require('../utils/contificoPrice');
const { calculateSaleLine } = require('../utils/tax');

const cobrar = (unitPrice) => calculateSaleLine({
  product: { taxCategory: 'IVA_15', taxRate: 15, priceIncludesVat: true }, quantity: 1, unitPrice,
});

test('HIDRAURE: pvp1 14.35 al 15 % se cobra 16.50 = 14.35 + 2.15, como en Contífico', () => {
  assert.equal(pvpConIva('14.350000', 15), 16.5);
  const l = cobrar(16.5);
  assert.deepEqual([l.taxBase, l.taxAmount, l.lineTotal], [14.35, 2.15, 16.5]);
});

test('el IVA se redondea como la factura (35.50 → 5.33), no como la coma flotante', () => {
  assert.equal(pvpConIva(35.5, 15), 40.83);
  const l = cobrar(40.83);
  assert.deepEqual([l.taxBase, l.taxAmount], [35.5, 5.33]);
});

test('tarifa 0 o sin tarifa deja el pvp1 tal cual', () => {
  assert.equal(pvpConIva('39.000000', 0), 39);
  assert.equal(pvpConIva(12.5, null), 12.5);
  assert.equal(pvpConIva(-3, 15), 0);
});
