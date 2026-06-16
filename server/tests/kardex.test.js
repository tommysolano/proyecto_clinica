const test = require('node:test');
const assert = require('node:assert/strict');
const { planConsumption } = require('../utils/kardex');

function layer(id, qty, cost) {
  return { _id: id, qtyRemaining: qty, unitCost: cost };
}

test('FIFO consumes the oldest layer first', () => {
  const layers = [layer('a', 10, 2), layer('b', 10, 3)];
  const { plan, totalCost, shortfall } = planConsumption(layers, 5);
  assert.equal(shortfall, 0);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].layerId, 'a');
  assert.equal(plan[0].qty, 5);
  assert.equal(totalCost, 10); // 5 * 2
});

test('FIFO spans multiple layers with weighted cost', () => {
  const layers = [layer('a', 10, 2), layer('b', 10, 3)];
  const { plan, totalCost, shortfall } = planConsumption(layers, 15);
  assert.equal(shortfall, 0);
  assert.equal(plan.length, 2);
  assert.equal(plan[0].qty, 10);
  assert.equal(plan[1].qty, 5);
  assert.equal(totalCost, 35); // 10*2 + 5*3
});

test('reports shortfall when layers do not cover the quantity', () => {
  const layers = [layer('a', 4, 2)];
  const { plan, totalCost, shortfall } = planConsumption(layers, 10);
  assert.equal(plan.length, 1);
  assert.equal(totalCost, 8); // 4 * 2
  assert.equal(shortfall, 6);
});

test('skips exhausted layers', () => {
  const layers = [layer('a', 0, 2), layer('b', 5, 4)];
  const { plan, totalCost } = planConsumption(layers, 3);
  assert.equal(plan.length, 1);
  assert.equal(plan[0].layerId, 'b');
  assert.equal(totalCost, 12); // 3 * 4
});

test('handles fractional quantities without floating residue', () => {
  const layers = [layer('a', 1, 10), layer('b', 1, 20)];
  const { plan, totalCost, shortfall } = planConsumption(layers, 1.5);
  assert.equal(shortfall, 0);
  assert.equal(plan[0].qty, 1);
  assert.equal(plan[1].qty, 0.5);
  assert.equal(totalCost, 20); // 1*10 + 0.5*20
});
