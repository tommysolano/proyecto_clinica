'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ContificoApi } = require('../services/contificoApi');
const { checksum, parseDate, fmt, months, externalId, search, parseArgs } = require('../scripts/migrateContifico');
const { accountType, nature, splitName, tax, ledgerDocType } = require('../scripts/migrateContificoProject');
const { _decode } = require('../controllers/contificoArchiveController');
const { decodeCompressedJson } = require('../utils/compressedJson');
const zlib = require('zlib');

test('checksum es estable y las fechas conservan el dia', () => {
  assert.equal(checksum({ b: 2, a: 1 }), checksum({ a: 1, b: 2 }));
  assert.equal(fmt(parseDate('31/08/2026')), '31/08/2026');
  assert.deepEqual(months(parseDate('15/11/2025'), parseDate('02/01/2026')).map((item) => item.key), ['2025-11', '2025-12', '2026-01']);
});

test('identidad y busqueda documental', () => {
  const row = { id: 'abc', fecha_emision: '20/08/2026', documento: '001-001-1', total: '12.50', cliente: { cedula: '0901', razon_social: 'Prueba' } };
  assert.equal(externalId('document', row), 'abc');
  const fields = search('document', row);
  assert.equal(fields.number, '001-001-1');
  assert.equal(fields.identification, '0901');
  assert.equal(fields.amount, 12.5);
});

test('cliente API pagina solo con GET y Authorization', async () => {
  const calls = [];
  const responses = [
    { count: 3, next: 'https://test.local/items?page=2', results: [{ id: 1 }, { id: 2 }] },
    { count: 3, next: null, results: [{ id: 3 }] },
  ];
  const api = new ContificoApi({ apiKey: 'key', baseUrl: 'https://test.local', fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options });
    return { ok: true, json: async () => responses.shift() };
  } });
  const ids = [];
  for await (const page of api.pages('/items', {}, 2)) ids.push(...page.rows.map((row) => row.id));
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.headers.Authorization, 'key');
});

test('CLI permanece dry-run sin --commit', () => {
  assert.equal(parseArgs(['--phase=extract']).commit, false);
  assert.equal(parseArgs(['--phase=extract', '--commit']).commit, true);
});

test('mapeos contables y tributarios de proyeccion', () => {
  assert.equal(accountType('1.1.01'), 'ACTIVO');
  assert.equal(accountType('5.1.03'), 'COSTO');
  assert.equal(accountType('5.2.01'), 'GASTO');
  assert.equal(nature('INGRESO'), 'CREDITO');
  assert.equal(nature('ACTIVO'), 'DEBITO');
  assert.deepEqual(tax(15), { taxRate: 15, taxCodeSri: '4', taxCategory: 'IVA_15' });
  assert.equal(ledgerDocType('NCT'), 'NC');
  assert.deepEqual(splitName('ANA PEREZ'), { firstName: 'ANA', lastName: 'PEREZ' });
});

test('archivo comprimido se recupera sin perdida', () => {
  const payload = { id: 'x', detalles: [{ cuenta_id: 'a', valor: '10.00' }], texto: 'áéíóú' };
  const record = { externalId: 'x', payloadCompressed: zlib.gzipSync(Buffer.from(JSON.stringify(payload))) };
  const decoded = _decode(record);
  assert.deepEqual(decoded.payload, payload);
  assert.equal(decoded.payloadCompressed, undefined);
  const compressed = zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  assert.deepEqual(decodeCompressedJson({ buffer: compressed, position: compressed.length }), payload);
});
