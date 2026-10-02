'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchWindow, monthRange } = require('../services/contificoFinancialSync');

test('una respuesta incompleta impide usar el lote financiero', async () => {
  const api = { async *pages(_path, _params, _size, stats) {
    Object.assign(stats, { expected: 3, unique: 2, complete: false });
    yield { rows: [{ id: '1' }, { id: '2' }] };
  } };
  const { from, through } = monthRange(2026, 9);
  await assert.rejects(fetchWindow(api, from, through), /incompletos/);
});

test('la ventana completa conserva una sola fila por ID', async () => {
  const api = { async *pages(_path, _params, _size, stats) {
    Object.assign(stats, { expected: 2, unique: 2, complete: true });
    yield { rows: [{ id: '1', glosa: 'original' }, { id: '2' }] };
    yield { rows: [{ id: '1', glosa: 'actualizado' }] };
  } };
  const { from, through } = monthRange(2026, 9);
  const result = await fetchWindow(api, from, through);
  assert.equal(result.rows.length, 2);
  assert.equal(result.rows[0].glosa, 'actualizado');
});
