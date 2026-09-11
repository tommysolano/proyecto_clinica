import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingSerums, serumProgress } from '../src/utils/serumProgress.js';

test('un suero con 3 de 4 aplicaciones sigue pendiente y reporta que falta 1', () => {
  const item = {
    isSerum: true,
    quantity: 4,
    administrations: [{}, {}, {}],
  };

  assert.deepEqual(serumProgress(item), {
    prescribed: 4,
    applied: 3,
    remaining: 1,
    pending: true,
  });
});

test('los sueros completos no aparecen entre los pendientes', () => {
  const followUp = {
    recetaItems: [
      { name: 'Completo', isSerum: true, quantity: 2, administrations: [{}, {}] },
      { name: 'Pendiente', isSerum: true, quantity: 3, administrations: [{}] },
      { name: 'Medicamento', isSerum: false, quantity: 5, administrations: [] },
    ],
  };

  assert.deepEqual(pendingSerums(followUp).map((item) => item.name), ['Pendiente']);
});

test('una cantidad vacía o cero no se ofrece como suero pendiente', () => {
  assert.equal(pendingSerums({ recetaItems: [{ isSerum: true, quantity: 0 }] }).length, 0);
  assert.equal(pendingSerums({ recetaItems: [{ isSerum: true }] }).length, 0);
});
