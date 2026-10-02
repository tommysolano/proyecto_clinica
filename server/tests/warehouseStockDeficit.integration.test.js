const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const controller = require('../controllers/inventoryAdvancedController');
const kardex = require('../services/kardexService');
const Warehouse = require('../models/Warehouse');
const Layer = require('../models/InventoryLayer');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('stock por bodega incluye el deficit importado sin volverlo disponible para FIFO', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const product = await H.makeProduct(clinicId, { code: 'CTF-NEG', name: 'Producto con deficit' });
  const [negativeWarehouse, positiveWarehouse] = await Warehouse.create([
    { clinic: clinicId, code: 'CENTRAL', name: 'Central' },
    { clinic: clinicId, code: 'EXTENSION', name: 'Extension' },
  ]);
  await Layer.create([
    { clinic: clinicId, product: product._id, warehouse: negativeWarehouse._id,
      qtyInitial: -5, qtyRemaining: -5, unitCost: 2, date: new Date('2026-09-30'),
      sourceModel: 'ContificoStock', exhausted: true },
    { clinic: clinicId, product: product._id, warehouse: positiveWarehouse._id,
      qtyInitial: 7, qtyRemaining: 7, unitCost: 2, date: new Date('2026-09-30'),
      sourceModel: 'ContificoStock', exhausted: false },
  ]);
  const response = await H.runController(controller.warehouseStock,
    H.mockReq(clinicId, userId, {}, { query: {} }));
  assert.equal(response.statusCode, 200);
  const row = response.payload.find((item) => item.product.code === 'CTF-NEG');
  assert.equal(row.totalQty, 2);
  assert.equal(row.warehouses.find((item) => item.warehouse.code === 'CENTRAL').qty, -5);
  assert.equal(row.warehouses.find((item) => item.warehouse.code === 'EXTENSION').qty, 7);
  const stock = await kardex.stockByWarehouse({ clinicId, warehouse: negativeWarehouse._id });
  assert.equal(stock.find((item) => String(item.product) === String(product._id)).qty, -5);
  assert.equal(await Layer.countDocuments({ clinic: clinicId, warehouse: negativeWarehouse._id,
    exhausted: false, qtyRemaining: { $gt: 0 } }), 0);
});
