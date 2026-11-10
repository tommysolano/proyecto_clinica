const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const Company = require('../models/Company');
const Clinic = require('../models/Clinic');
const InventoryCategory = require('../models/InventoryCategory');
const Product = require('../models/Product');
const products = require('../controllers/productController');
const inventory = require('../controllers/inventoryAdvancedController');
const { refreshCompanyCache } = require('../utils/companies');

test.before(async () => H.startDb());
test.after(async () => H.stopDb());
test.beforeEach(async () => H.resetDb());

test('categorías de productos compartidas por empresa, con aislamiento de otras empresas', async () => {
  const empresa = await Company.create({ name: 'Empresa' });
  const otraEmpresa = await Company.create({ name: 'Otra empresa' });
  const central = await Clinic.create({ name: 'Central', company: empresa._id });
  const extension = await Clinic.create({ name: 'Extensión', company: empresa._id });
  const ajena = await Clinic.create({ name: 'Ajena', company: otraEmpresa._id });
  const moleculas = await InventoryCategory.create({ clinic: central._id, code: 'MOL', name: 'MOLECULAS', kind: 'INVENTARIO' });
  const otraCategoria = await InventoryCategory.create({ clinic: ajena._id, code: 'OTRA', name: 'Otra', kind: 'INVENTARIO' });
  await refreshCompanyCache();

  const listado = await H.runController(inventory.listCategories, H.mockReq(extension._id, null, {}, { query: { catalog: 'company' } }));
  assert.deepEqual(listado.payload.map((c) => String(c._id)), [String(moleculas._id)]);
  const crear = (cat) => H.runController(products.createProduct, H.mockReq(extension._id, null, {
    name: 'Producto', category: 'insumo', salePrice: 10, inventoryCategory: String(cat._id),
  }));
  const creado = await crear(moleculas);
  assert.equal(creado.statusCode, 201, JSON.stringify(creado.payload));
  const guardado = await Product.findById(creado.payload._id);
  assert.equal(String(guardado.clinic), String(extension._id));
  assert.equal(String(guardado.inventoryCategory), String(moleculas._id));
  const rechazado = await crear(otraCategoria);
  assert.equal(rechazado.statusCode, 400);
  assert.match(rechazado.payload.message, /no existe o no pertenece/);
});
