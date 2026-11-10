import { test } from 'node:test';
import assert from 'node:assert/strict';
import { totalIncluded, includedLimit, remainingIncluded, boundedIncludedQuantity } from './includedComponents.js';

test('el límite suma las cantidades de todas las ampollas, incluso repetidas', () => {
  const item = { includedMax: 3, quantity: 1 };
  const elegidos = [{ product: 'a', quantity: 2 }, { product: 'b', quantity: 1 }];
  assert.equal(totalIncluded(elegidos), 3);
  assert.equal(includedLimit(item), 3);
  assert.equal(remainingIncluded(item, elegidos), 0);
  assert.equal(boundedIncludedQuantity('2', 3 - totalIncluded([elegidos[0]])), '1');
  assert.equal(boundedIncludedQuantity('10', 3), '3');
  assert.equal(boundedIncludedQuantity('', 3), '');
});

test('el límite aumenta por cada unidad del servicio y no afecta a vinculados tradicionales', () => {
  assert.equal(remainingIncluded({ includedMax: 3, quantity: 2 }, [{ quantity: 4 }]), 2);
  assert.equal(includedLimit({ quantity: 1 }), null);
  assert.equal(remainingIncluded({ quantity: 1 }, [{ quantity: 5 }]), null);
});
