/**
 * CLASE DE CATEGORÍA SEGÚN EL PRODUCTO (oct-2026). Un servicio con su categoría
 * contable SERVICIO («EXAMENES DE LABORATORIO») tiene que poder guardarse —por
 * ejemplo, al marcarle «Precio variable»—; antes el servidor exigía INVENTARIO
 * a todos. Un insumo, en cambio, sigue necesitando una categoría INVENTARIO.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const InventoryCategory = require('../models/InventoryCategory');
const ChartOfAccount = require('../models/ChartOfAccount');
const Product = require('../models/Product');
const products = require('../controllers/productController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function categorias(clinicId) {
  const ingreso = await ChartOfAccount.findOne({ clinic: clinicId, code: '4.1.01' });
  const servicio = await InventoryCategory.create({
    clinic: clinicId, code: 'LAB', name: 'EXAMENES DE LABORATORIO', kind: 'SERVICIO', incomeAccount: ingreso?._id || null,
  });
  return { servicio };
}

const actualizar = (clinicId, userId, id, body) => H.runController(
  products.updateProduct, H.mockReq(clinicId, userId, body, { params: { id: String(id) } })
);

test('un servicio con categoría SERVICIO se guarda con precio variable', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { servicio } = await categorias(clinicId);
  const lab = await H.makeProduct(clinicId, {
    name: 'Exámenes de laboratorio', category: 'servicio', unlimited: true, salePrice: 10, inventoryCategory: servicio._id,
  });
  const r = await actualizar(clinicId, userId, lab._id, {
    category: 'servicio', unlimited: true, inventoryCategory: String(servicio._id), variablePrice: true,
  });
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const guardado = await Product.findById(lab._id);
  assert.equal(guardado.variablePrice, true);
  assert.equal(String(guardado.inventoryCategory), String(servicio._id));
});

test('un insumo NO puede ir a una categoría SERVICIO', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { servicio } = await categorias(clinicId);
  const insumo = await H.makeProduct(clinicId, { name: 'Jeringa', category: 'insumo', stock: 3 });
  const r = await actualizar(clinicId, userId, insumo._id, {
    category: 'insumo', unlimited: false, inventoryCategory: String(servicio._id),
  });
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /no es de tipo INVENTARIO/);
});
