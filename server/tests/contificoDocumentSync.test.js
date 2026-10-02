'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { checksum } = require('../scripts/migrateContifico');
const { fetchDocumentWindow, planDocumentChanges, documentDifferences } = require('../services/contificoDocumentSync');
const { monthRange } = require('../services/contificoFinancialSync');

const sale = (fields = {}) => ({ id: 'S1', tipo_registro: 'CLI', tipo_documento: 'FAC', documento: '001-001-1',
  total: '115.00', saldo: '0.00', anulado: false, ...fields });
const purchase = (fields = {}) => ({ id: 'P1', tipo_registro: 'PRO', tipo_documento: 'FAC', documento: '001-001-9',
  total: '50.00', saldo: '50.00', anulado: false, ...fields });
const archivedFor = (row, links) => ({ _id: `rec-${row.id}`, externalId: row.id, checksum: checksum(row),
  projection: { links } });

test('una ventana de documentos incompleta no se usa', async () => {
  const api = { async *pages(_path, _params, _size, stats) {
    Object.assign(stats, { expected: 3, unique: 2, complete: false });
    yield { rows: [{ id: '1' }, { id: '2' }] };
  } };
  const { from, through } = monthRange(2026, 9);
  await assert.rejects(fetchDocumentWindow(api, from, through), /incompletos/);
});

test('solo se reproyectan documentos nuevos, modificados o sin enlace local', () => {
  const same = sale({ id: 'A' });
  const edited = sale({ id: 'B', total: '120.00' });
  const unlinked = purchase({ id: 'C' });
  const other = { id: 'D', tipo_registro: 'CLI', tipo_documento: 'PRE', total: '1' };
  const fresh = sale({ id: 'E' });
  const archived = new Map([
    ['A', archivedFor(same, [{ model: 'Sale', ref: 'x' }])],
    ['B', archivedFor(sale({ id: 'B' }), [{ model: 'Sale', ref: 'y' }])],
    ['C', archivedFor(unlinked, [])],
    ['D', archivedFor(other, [])],
  ]);
  const ids = planDocumentChanges([same, edited, unlinked, other, fresh], archived).map((row) => row.id);
  assert.deepEqual(ids, ['B', 'C', 'E']);
});

test('detecta total, saldo, anulación y cartera distintos por documento', () => {
  const paid = sale({ id: 'S1', saldo: '0.00' });
  const voided = sale({ id: 'S2', anulado: true, saldo: '0.00' });
  const open = purchase({ id: 'P1', saldo: '20.00' });
  const archivedById = new Map([paid, voided, open].map((row) => [row.id, archivedFor(row, [])]));
  const differences = documentDifferences([paid, voided, open], {
    archivedById,
    salesByKey: new Map([
      ['contifico:S1', { total: 115, balance: 0, status: 'completada' }],
      ['contifico:S2', { total: 115, balance: 0, status: 'completada' }],
    ]),
    purchasesByRef: new Map([['rec-P1', { total: 49, balance: 20, status: 'REGISTRADA' }]]),
    // La CxC de S1 quedó abierta aunque Contífico ya la cobró.
    ledgerByRef: new Map([['rec-S1', { balance: 115 }]]),
  });
  assert.deepEqual(differences.map((item) => `${item.id}:${item.field}`).sort(),
    ['P1:cartera', 'P1:total', 'S1:cartera', 'S2:estado']);
});

test('un documento cuadrado no informa diferencias', () => {
  const row = purchase({ saldo: '0.00' });
  const differences = documentDifferences([row], {
    archivedById: new Map([[row.id, archivedFor(row, [])]]),
    salesByKey: new Map(),
    purchasesByRef: new Map([['rec-P1', { total: 50, balance: 0, status: 'PAGADA' }]]),
    ledgerByRef: new Map([['rec-P1', { balance: 0, status: 'PAGADO' }]]),
  });
  assert.deepEqual(differences, []);
});
