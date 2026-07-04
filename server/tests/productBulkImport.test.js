/**
 * Carga masiva de productos con categoría contable de inventario.
 * Cubre las dos rutas: JSON (importProducts) y Excel (importProductsExcel).
 *   - resuelve inventoryCategory por nombre y por id;
 *   - rechaza (error de fila) físicos con categoría inexistente/ inactiva;
 *   - permite servicios sin categoría contable;
 *   - NO crea categorías automáticamente;
 *   - compatibilidad con columnas antiguas (`categoria`).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const invAdv = require('../controllers/inventoryAdvancedController');
const Product = require('../models/Product');
const InventoryCategory = require('../models/InventoryCategory');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function makeCategory(clinicId, over = {}) {
  return InventoryCategory.create({
    clinic: clinicId, code: over.code || 'INV-01', name: over.name || 'Ampollas',
    kind: over.kind || 'INVENTARIO', active: over.active !== false,
  });
}

async function buildExcel(headers, rows) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Productos');
  ws.addRow(headers);
  for (const r of rows) ws.addRow(r);
  return wb.xlsx.writeBuffer();
}
function excelReq(clinicId, userId, buffer) {
  const req = H.mockReq(clinicId, userId);
  req.file = { buffer };
  return req;
}

// ─────────────────────────────── JSON (importProducts) ───────────────────────
test('JSON: insumo con categoriaContable por nombre asigna inventoryCategory', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = await makeCategory(clinicId, { name: 'Ampollas' });
  const r = await H.runController(invAdv.importProducts, H.mockReq(clinicId, userId, {
    rows: [{ code: 'P1', name: 'A', category: 'insumo', salePrice: 10, stock: 1, categoriaContable: 'ampollas' }],
  }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.created, 1);
  assert.equal((r.payload.errors || []).length, 0);
  const p = await Product.findOne({ clinic: clinicId, code: 'P1' });
  assert.equal(String(p.inventoryCategory), String(cat._id));
  assert.equal(p.categoria, 'Ampollas');
});

test('JSON: insumo con inventoryCategoryId asigna correctamente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = await makeCategory(clinicId, { name: 'Cremas', code: 'INV-02' });
  const r = await H.runController(invAdv.importProducts, H.mockReq(clinicId, userId, {
    rows: [{ code: 'P2', name: 'B', category: 'insumo', salePrice: 10, stock: 1, inventoryCategoryId: String(cat._id) }],
  }));
  assert.equal(r.payload.created, 1);
  const p = await Product.findOne({ clinic: clinicId, code: 'P2' });
  assert.equal(String(p.inventoryCategory), String(cat._id));
  assert.equal(p.categoria, 'Cremas');
});

test('JSON: insumo con categoría inexistente → error de fila, no crea producto ni categoría', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await makeCategory(clinicId, { name: 'Ampollas' });
  const r = await H.runController(invAdv.importProducts, H.mockReq(clinicId, userId, {
    rows: [{ code: 'P3', name: 'C', category: 'insumo', salePrice: 10, stock: 1, categoriaContable: 'No Existe' }],
  }));
  assert.equal(r.payload.created, 0);
  assert.equal(r.payload.errors.length, 1);
  assert.match(r.payload.errors[0], /no existe o no está configurada/i);
  assert.equal(await Product.countDocuments({ clinic: clinicId, code: 'P3' }), 0);
  // No se crean categorías automáticamente.
  assert.equal(await InventoryCategory.countDocuments({ clinic: clinicId }), 1);
});

test('JSON: servicio sin categoría contable se permite', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await H.runController(invAdv.importProducts, H.mockReq(clinicId, userId, {
    rows: [{ code: 'S1', name: 'Consulta', category: 'servicio', salePrice: 20, unlimited: true }],
  }));
  assert.equal(r.payload.created, 1);
  const p = await Product.findOne({ clinic: clinicId, code: 'S1' });
  assert.equal(p.inventoryCategory, null);
});

test('JSON: errores parciales — buenas filas entran, malas se reportan', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await makeCategory(clinicId, { name: 'Ampollas' });
  const r = await H.runController(invAdv.importProducts, H.mockReq(clinicId, userId, {
    rows: [
      { code: 'OK1', name: 'A', category: 'insumo', salePrice: 10, stock: 1, categoriaContable: 'Ampollas' },
      { code: 'BAD', name: 'B', category: 'insumo', salePrice: 10, stock: 1, categoriaContable: 'Nope' },
      { code: 'SVC', name: 'Svc', category: 'servicio', salePrice: 20, unlimited: true },
    ],
  }));
  assert.equal(r.payload.created, 2);          // OK1 + SVC
  assert.equal(r.payload.errors.length, 1);    // BAD
  assert.equal(await Product.countDocuments({ clinic: clinicId, code: 'BAD' }), 0);
});

test('JSON: compatibilidad con columna antigua `categoria` (resuelve por nombre)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = await makeCategory(clinicId, { name: 'Ampollas' });
  const r = await H.runController(invAdv.importProducts, H.mockReq(clinicId, userId, {
    rows: [{ code: 'P9', name: 'Legacy', category: 'insumo', salePrice: 10, stock: 1, categoria: 'AMPOLLAS' }],
  }));
  assert.equal(r.payload.created, 1);
  const p = await Product.findOne({ clinic: clinicId, code: 'P9' });
  assert.equal(String(p.inventoryCategory), String(cat._id));
});

test('JSON: categoría inactiva → error de fila', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await makeCategory(clinicId, { name: 'Ampollas', active: false });
  const r = await H.runController(invAdv.importProducts, H.mockReq(clinicId, userId, {
    rows: [{ code: 'P4', name: 'D', category: 'insumo', salePrice: 10, stock: 1, categoriaContable: 'Ampollas' }],
  }));
  assert.equal(r.payload.created, 0);
  assert.match(r.payload.errors[0], /inactiva/i);
});

// ─────────────────────────────── Excel (importProductsExcel) ─────────────────
test('Excel: resuelve por nombre (categoria_contable), rechaza inexistente y permite servicio', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = await makeCategory(clinicId, { name: 'Ampollas' });
  const buffer = await buildExcel(
    ['codigo', 'nombre', 'tipo', 'categoria_contable', 'precio_venta', 'stock', 'ilimitado'],
    [
      ['E1', 'ProdA', 'insumo', 'Ampollas', 10, 5, 'NO'],
      ['E2', 'ProdB', 'insumo', 'NoExiste', 10, 5, 'NO'],
      ['E3', 'Svc', 'servicio', '', 20, 0, 'SI'],
    ],
  );
  const r = await H.runController(invAdv.importProductsExcel, excelReq(clinicId, userId, buffer));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.created, 2, 'E1 (insumo) y E3 (servicio)');
  assert.equal(r.payload.errors.length, 1);
  assert.match(r.payload.errors[0], /E2:/);
  const e1 = await Product.findOne({ clinic: clinicId, code: 'E1' });
  assert.equal(String(e1.inventoryCategory), String(cat._id));
  assert.equal(e1.categoria, 'Ampollas');
  const e3 = await Product.findOne({ clinic: clinicId, code: 'E3' });
  assert.equal(e3.inventoryCategory, null);
  assert.equal(await Product.countDocuments({ clinic: clinicId, code: 'E2' }), 0);
  // No se crearon categorías nuevas.
  assert.equal(await InventoryCategory.countDocuments({ clinic: clinicId }), 1);
});

test('Excel: acepta encabezado alias `inventoryCategory` con id', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = await makeCategory(clinicId, { name: 'Cremas', code: 'INV-02' });
  const buffer = await buildExcel(
    ['codigo', 'nombre', 'tipo', 'inventoryCategory', 'precio_venta', 'stock'],
    [['E4', 'ProdC', 'insumo', String(cat._id), 10, 3]],
  );
  const r = await H.runController(invAdv.importProductsExcel, excelReq(clinicId, userId, buffer));
  assert.equal(r.payload.created, 1, JSON.stringify(r.payload));
  const p = await Product.findOne({ clinic: clinicId, code: 'E4' });
  assert.equal(String(p.inventoryCategory), String(cat._id));
});
