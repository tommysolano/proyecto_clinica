/**
 * Unificación de productos con categorías contables de inventario.
 *   - validación de `inventoryCategory` en create/update de productos físicos;
 *   - populate de la categoría con sus cuentas en getProducts;
 *   - resolución legacy de `categoria` (texto) → InventoryCategory;
 *   - migración de categorías (creación + asignación) e idempotencia.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const product = require('../controllers/productController');
const Product = require('../models/Product');
const InventoryCategory = require('../models/InventoryCategory');
const ChartOfAccount = require('../models/ChartOfAccount');
const { getAccount } = require('../utils/accountMap');
const { migrate } = require('../scripts/migrateProductCategoriesToInventoryCategories');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function makeCategory(clinicId, over = {}) {
  return InventoryCategory.create({
    clinic: clinicId, code: over.code || 'INV-01', name: over.name || 'Ampollas',
    kind: over.kind || 'INVENTARIO', active: over.active !== false,
    assetAccount: over.assetAccount || null, expenseAccount: over.expenseAccount || null, incomeAccount: over.incomeAccount || null,
  });
}

const baseInsumo = (over = {}) => ({ name: 'Insumo X', category: 'insumo', salePrice: 10, purchasePrice: 5, stock: 3, ...over });

// ─────────────────────────────────────────────────────────────────────────────
test('crea producto físico con inventoryCategory válida y sincroniza categoria', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = await makeCategory(clinicId, { name: 'Ampollas' });
  const r = await H.runController(product.createProduct, H.mockReq(clinicId, userId, baseInsumo({ inventoryCategory: String(cat._id), categoria: 'texto viejo' })));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(String(r.payload.inventoryCategory), String(cat._id));
  assert.equal(r.payload.categoria, 'Ampollas'); // sincronizado con el nombre de la categoría
});

// ─────────────────────────────────────────────────────────────────────────────
test('rechaza producto físico sin categoría contable', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await H.runController(product.createProduct, H.mockReq(clinicId, userId, baseInsumo()));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /categor[ií]a contable/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('rechaza producto físico con categoría de otra clínica', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const other = await H.seedClinic();
  const cat = await makeCategory(other.clinicId, { name: 'Ampollas' });
  const r = await H.runController(product.createProduct, H.mockReq(clinicId, userId, baseInsumo({ inventoryCategory: String(cat._id) })));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no existe|no pertenece/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('rechaza producto físico con categoría inactiva', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = await makeCategory(clinicId, { name: 'Ampollas', active: false });
  const r = await H.runController(product.createProduct, H.mockReq(clinicId, userId, baseInsumo({ inventoryCategory: String(cat._id) })));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /inactiva/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('rechaza producto físico con categoría kind ACTIVO_FIJO', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = await makeCategory(clinicId, { name: 'Equipos', kind: 'ACTIVO_FIJO' });
  const r = await H.runController(product.createProduct, H.mockReq(clinicId, userId, baseInsumo({ inventoryCategory: String(cat._id) })));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /INVENTARIO/);
});

// ─────────────────────────────────────────────────────────────────────────────
test('permite servicio y programa sin inventoryCategory', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const svc = await H.runController(product.createProduct, H.mockReq(clinicId, userId, { name: 'Consulta', category: 'servicio', salePrice: 20, unlimited: true }));
  assert.equal(svc.statusCode, 201, JSON.stringify(svc.payload));
  const prog = await H.runController(product.createProduct, H.mockReq(clinicId, userId, { name: 'Paquete', category: 'programa', salePrice: 100, unlimited: true }));
  assert.equal(prog.statusCode, 201, JSON.stringify(prog.payload));
});

// ─────────────────────────────────────────────────────────────────────────────
test('getProducts devuelve inventoryCategory populada con cuentas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const asset = await getAccount(clinicId, 'inventario');
  const cost = await getAccount(clinicId, 'costoProductos');
  const income = await getAccount(clinicId, 'ingresoProductos');
  const cat = await makeCategory(clinicId, { name: 'Ampollas', assetAccount: asset._id, expenseAccount: cost._id, incomeAccount: income._id });
  await H.runController(product.createProduct, H.mockReq(clinicId, userId, baseInsumo({ inventoryCategory: String(cat._id) })));

  const r = await H.runController(product.getProducts, H.mockReq(clinicId, userId, {}, { query: {} }));
  assert.equal(r.statusCode, 200);
  const p = r.payload.find((x) => String(x.inventoryCategory?._id) === String(cat._id));
  assert.ok(p, 'el producto debe venir con inventoryCategory populada');
  assert.equal(p.inventoryCategory.name, 'Ampollas');
  assert.equal(p.inventoryCategory.assetAccount.code, asset.code);
  assert.equal(p.inventoryCategory.expenseAccount.code, cost.code);
  assert.equal(p.inventoryCategory.incomeAccount.code, income.code);

  // Filtro por inventoryCategory.
  const filtered = await H.runController(product.getProducts, H.mockReq(clinicId, userId, {}, { query: { inventoryCategory: String(cat._id) } }));
  assert.equal(filtered.payload.length, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('producto legacy con categoria texto se resuelve a inventoryCategory por nombre normalizado', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = await makeCategory(clinicId, { name: 'Ampollas' });
  // Llega solo `categoria` en MAYÚSCULAS/variación → debe resolver a la categoría existente.
  const r = await H.runController(product.createProduct, H.mockReq(clinicId, userId, baseInsumo({ categoria: 'AMPOLLAS' })));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(String(r.payload.inventoryCategory), String(cat._id));
  assert.equal(r.payload.categoria, 'Ampollas');
});

// ─────────────────────────────────────────────────────────────────────────────
test('migración crea categorías faltantes, asigna productos y es idempotente', async () => {
  const { clinicId } = await H.seedClinic();
  // Productos físicos legacy (categoria texto, sin inventoryCategory).
  await Product.create({ clinic: clinicId, code: 'P1', name: 'A', category: 'insumo', categoria: 'Ampollas', salePrice: 5, stock: 1 });
  await Product.create({ clinic: clinicId, code: 'P2', name: 'B', category: 'insumo', categoria: 'ampollas', salePrice: 5, stock: 1 }); // mismo nombre normalizado
  await Product.create({ clinic: clinicId, code: 'P3', name: 'C', category: 'insumo', categoria: 'Cremas', salePrice: 5, stock: 1 });
  // Servicio legacy: no debe migrarse.
  await Product.create({ clinic: clinicId, code: 'S1', name: 'Svc', category: 'servicio', categoria: 'SERVICIOS MEDICOS', salePrice: 20, unlimited: true });

  const stats = await migrate({ commit: true });
  assert.equal(stats.categoriesCreated, 2, 'Ampollas y Cremas (ampollas/Ampollas se unifican)');
  assert.equal(stats.productsAssigned, 3);

  const cats = await InventoryCategory.find({ clinic: clinicId, kind: 'INVENTARIO' });
  assert.equal(cats.length, 2);
  const ampollas = cats.find((c) => c.name === 'Ampollas');
  assert.ok(ampollas.assetAccount && ampollas.expenseAccount && ampollas.incomeAccount, 'cuentas por defecto asignadas');

  const p1 = await Product.findOne({ clinic: clinicId, code: 'P1' });
  const p2 = await Product.findOne({ clinic: clinicId, code: 'P2' });
  assert.equal(String(p1.inventoryCategory), String(ampollas._id));
  assert.equal(String(p2.inventoryCategory), String(ampollas._id)); // misma categoría (normalizado)
  assert.equal(p1.categoria, 'Ampollas'); // texto legacy conservado
  const svc = await Product.findOne({ clinic: clinicId, code: 'S1' });
  assert.equal(svc.inventoryCategory, null, 'el servicio no se migra');

  // Idempotencia: 2ª corrida no crea ni reasigna nada.
  const stats2 = await migrate({ commit: true });
  assert.equal(stats2.categoriesCreated, 0);
  assert.equal(stats2.productsAssigned, 0);
  assert.equal((await InventoryCategory.find({ clinic: clinicId, kind: 'INVENTARIO' })).length, 2);
});

// ─────────────────────────────────────────────────────────────────────────────
test('migración dry-run no escribe nada', async () => {
  const { clinicId } = await H.seedClinic();
  await Product.create({ clinic: clinicId, code: 'P1', name: 'A', category: 'insumo', categoria: 'Ampollas', salePrice: 5, stock: 1 });
  const stats = await migrate({ commit: false });
  assert.equal(stats.categoriesCreated, 1); // reporta lo que haría
  assert.equal(stats.productsAssigned, 1);
  assert.equal((await InventoryCategory.countDocuments({ clinic: clinicId })), 0, 'dry-run no crea categorías');
  const p1 = await Product.findOne({ clinic: clinicId, code: 'P1' });
  assert.equal(p1.inventoryCategory, null, 'dry-run no asigna');
});
