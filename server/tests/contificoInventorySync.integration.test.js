/**
 * INVENTARIO SINCRONIZADO CON CONTÍFICO.
 *
 * El stock de cada producto físico queda igual al de Contífico (decisión de la clínica,
 * 06-10-2026), pero lo que aquí está marcado como servicio no se toca aunque en Contífico
 * sea un producto. Y un movimiento ya importado se actualiza con la misma clave: no se duplica.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const H = require('./_integrationHelpers');

const { syncStock, movementRows } = require('../services/contificoInventorySync');
const Product = require('../models/Product');
const Record = require('../models/ContificoRecord');

const { ObjectId } = H.mongoose.Types;

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** API falsa: una sola página completa. */
const fakeApi = (rows) => ({
  async *pages(_path, _params, _size, stats) {
    stats.expected = rows.length; stats.complete = true; stats.unique = rows.length;
    yield { rows, count: rows.length };
  },
});

test('el stock de los insumos queda como en Contífico; los servicios no se tocan', async () => {
  const clinic = { _id: new ObjectId(), name: 'Central' };
  const [insumo, servicio] = [new ObjectId(), new ObjectId()];
  await Product.collection.insertMany([
    { _id: insumo, clinic: clinic._id, name: 'Ampolla', category: 'insumo', unlimited: false, stock: 3, stockByClinic: [{ clinic: clinic._id, stock: 3 }] },
    { _id: servicio, clinic: clinic._id, name: 'Marcado como servicio', category: 'servicio', unlimited: true, stock: 0, stockByClinic: [] },
  ]);
  const link = (ref) => ({ status: 'PROJECTED', links: [{ model: 'Product', ref, action: 'LINK' }] });
  const gz = zlib.gzipSync(Buffer.from('{}'));
  await Record.collection.insertMany([
    { clinic: clinic._id, entity: 'product', externalId: 'P1', payloadCompressed: gz, checksum: 'x', projection: link(insumo) },
    { clinic: clinic._id, entity: 'product', externalId: 'P2', payloadCompressed: gz, checksum: 'x', projection: link(servicio) },
  ]);
  const api = fakeApi([{ id: 'P1', tipo: 'PRO', cantidad_stock: '-2.0' }, { id: 'P2', tipo: 'PRO', cantidad_stock: '40' }]);

  assert.equal((await syncStock({ clinic, api, commit: false })).updated, 1);
  const result = await syncStock({ clinic, api });
  assert.deepEqual([result.updated, result.skippedServices], [1, 1]);
  const [a, s] = await Promise.all([Product.findById(insumo).lean(), Product.findById(servicio).lean()]);
  // El déficit de Contífico se refleja tal cual.
  assert.equal(a.stock, -2);
  assert.deepEqual(a.stockByClinic.map((entry) => entry.stock), [-2]);
  assert.equal(s.stock, 0);
  assert.equal(s.category, 'servicio');
  assert.equal((await syncStock({ clinic, api })).updated, 0);
});

test('un traslado son dos filas de kardex con las claves de la importación', () => {
  const clinicId = new ObjectId();
  const [product, from, to] = [new ObjectId(), new ObjectId(), new ObjectId()];
  const maps = { products: new Map([['P1', product]]), warehouses: new Map([['B1', from], ['B2', to]]) };
  const record = { _id: new ObjectId() };
  const row = { codigo: 'TRA 1', tipo: 'TRA', fecha: '2026-10-05', bodega_id: 'B1', bodega_destino_id: 'B2',
    detalles: [{ producto_id: 'P1', cantidad: '2', costo_promedio: '1.5' }, { producto_id: 'NUEVO', cantidad: '1' }] };
  const { rows, missing } = movementRows(clinicId, record, row, maps);
  assert.deepEqual(rows.map((r) => [r.type, r.reference, String(r.warehouse)]),
    [['salida', 'TRA 1:0:OUT', String(from)], ['entrada', 'TRA 1:0:IN', String(to)]]);
  assert.equal(rows[0].totalCost, 3);
  assert.deepEqual(missing, ['NUEVO']);
});
