/**
 * Pruebas puras del cálculo de retenciones (sin DB): base por tipo, monto, redondeo,
 * validaciones y agrupación para el resumen/cabecera.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  lineBase, lineIva, computeRetentionBase, computeRetention, groupLineRetentions,
} = require('../utils/retentionCalculator');

const line = (o = {}) => ({ quantity: 10, unitPrice: 5, discount: 0, ivaRate: 15, ...o });

test('lineBase considera cantidad, precio y descuento', () => {
  assert.equal(lineBase(line()), 50);
  assert.equal(lineBase(line({ discount: 5 })), 45);
  assert.equal(lineBase({ subtotal: 123.456 }), 123.46); // usa subtotal si viene, redondea
});

test('lineIva deriva de la tarifa o usa ivaAmount', () => {
  assert.equal(lineIva(line({ ivaRate: 15 })), 7.5);
  assert.equal(lineIva(line({ ivaRate: 0 })), 0);
  assert.equal(lineIva(line({ ivaRate: 15, ivaAmount: 7.49 })), 7.49);
});

test('computeRetentionBase respeta el baseType', () => {
  const l15 = line({ ivaRate: 15 });   // base 50, iva 7.5
  const l0 = line({ ivaRate: 0 });     // base 50, iva 0
  assert.equal(computeRetentionBase(l15, 'SUBTOTAL_TOTAL'), 50);
  assert.equal(computeRetentionBase(l15, 'SUBTOTAL_IVA'), 50);
  assert.equal(computeRetentionBase(l15, 'SUBTOTAL_0'), 0);
  assert.equal(computeRetentionBase(l15, 'IVA'), 7.5);
  assert.equal(computeRetentionBase(l0, 'SUBTOTAL_0'), 50);
  assert.equal(computeRetentionBase(l0, 'SUBTOTAL_IVA'), 0);
  assert.equal(computeRetentionBase(l0, 'IVA'), 0);
});

test('computeRetention calcula base y monto con redondeo a 2 decimales', () => {
  assert.deepEqual(computeRetention(line({ ivaRate: 0 }), { rate: 2, baseType: 'SUBTOTAL_TOTAL' }), { base: 50, amount: 1 });
  assert.deepEqual(computeRetention(line({ ivaRate: 15 }), { rate: 30, baseType: 'IVA' }), { base: 7.5, amount: 2.25 });
  // 100 * 1.75% = 1.75
  assert.deepEqual(computeRetention({ subtotal: 100, ivaRate: 0 }, { rate: 1.75, baseType: 'SUBTOTAL_TOTAL' }), { base: 100, amount: 1.75 });
});

test('computeRetention valida base negativa y porcentaje fuera de rango', () => {
  assert.throws(() => computeRetention({ subtotal: -10, ivaRate: 0 }, { rate: 2, baseType: 'SUBTOTAL_TOTAL' }), /negativa/);
  assert.throws(() => computeRetention(line(), { rate: 150, baseType: 'SUBTOTAL_TOTAL' }), /entre 0 y 100/);
});

test('groupLineRetentions agrupa por type/code/account y suma', () => {
  const items = [
    { retention: { type: 'RENTA', code: '312', rate: 2, base: 50, amount: 1, account: 'A' } },
    { retention: { type: 'RENTA', code: '312', rate: 2, base: 20, amount: 0.4, account: 'A' } }, // mismo → suma
    { retention: { type: 'RENTA', code: '310', rate: 1, base: 100, amount: 1, account: 'A' } },   // otro código
    { retention: { type: 'IVA', code: '721', rate: 30, base: 7.5, amount: 2.25, account: 'B' } },
    { retention: null },
  ];
  const g = groupLineRetentions(items);
  assert.equal(g.length, 3);
  const r312 = g.find((x) => x.code === '312');
  assert.equal(r312.base, 70);
  assert.equal(r312.amount, 1.4);
  assert.equal(r312.baseAmount, 70); // alias legacy
  assert.equal(r312.percentage, 2);
});
