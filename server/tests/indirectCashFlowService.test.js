'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { calculateFromMovements } = require('../services/indirectCashFlowService');

test('el flujo indirecto clasifica los movimientos del mayor y concilia con caja', () => {
  const movements = [
    ['4.1.1', 0, 718929.48, 'INGRESO'],
    ['5.1.1', 219730.94, 0, 'COSTO'],
    ['5.2.1', 408096.37, 0, 'GASTO'],
    ['1.1.1.3', 187871.16, 0],
    ['1.1.2.5.1', 9667.08, 0],
    ['2.1.3.1.1', 0, 236743.28],
    ['2.1.3.2.1', 1394, 0],
    ['2.1.7.1.4', 17165.84, 0],
    ['2.1.7.4.1', 0, 1441.95],
    ['1.1.2.5.7.1', 53458.53, 0],
    ['2.1.4.3.1', 389.82, 0],
    ['1.1.2.5.4.1', 1285, 0],
    ['1.1.3.6', 0, 12138.39],
    ['1.1.3.9', 2.4, 0],
    ['1.1.4.3', 1831.96, 0],
    ['1.1.5.1.1', 6018.87, 0],
    ['1.1.5.3.2', 621.68, 0],
    ['1.2.1.11', 0, 347.69],
    ['2.1.10', 0, 101.75],
    ['1.1.2.2', 2700, 0],
    ['1.1.7', 34.99, 0],
    ['1.2.1.4', 12715.41, 0],
    ['1.2.1.5', 31547.72, 0],
    ['1.2.1.15', 1813.34, 0],
    ['1.2.1.6', 6205.01, 0],
    ['1.2.1.7', 3850.6, 0],
    ['1.2.1.9', 3301.82, 0],
  ].map(([code, debit, credit, type]) => ({ code, debit, credit, type,
    nature: type === 'INGRESO' ? 'CREDITO' : 'DEBITO', allowsMovement: true }));
  const result = calculateFromMovements(movements);
  assert.equal(result.result, 91102.17);
  assert.equal(result.operating.total, 250040.05);
  assert.equal(result.investing.rows.find((row) => row.label === 'Muebles y Enseres').amount, 33361.06);
  assert.equal(result.investing.total, -62168.89);
  assert.equal(result.net, 187871.16);
  assert.equal(result.cashMovement, 187871.16);
  assert.equal(result.difference, 0);
});
