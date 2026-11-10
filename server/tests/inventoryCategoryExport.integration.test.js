const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');
const InventoryCategory = require('../models/InventoryCategory');
const controller = require('../controllers/inventoryAdvancedController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function workbook(payload) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(payload);
  return wb;
}

async function exportFile(req) {
  const { res, state } = H.mockRes();
  const finished = new Promise((resolve) => res.once('finish', resolve));
  await controller.exportCategoryItems(req, res);
  if (!state.done) await finished;
  return state;
}

test('exporta los ítems habilitados de la categoría, su IVA y todas las listas de precio', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const first = await H.makeProduct(clinicId, {
    code: '001', name: 'Ampolla activa', stock: 8, averageCost: 4,
    salePrice: 29, salePrices: [{ name: 'General', price: 29, active: true }, { name: 'Convenio', price: 25, active: false }],
    taxCategory: 'IVA_15', taxRate: 15, priceIncludesVat: true,
  });
  const category = await InventoryCategory.findById(first.inventoryCategory);
  const other = await InventoryCategory.create({ clinic: clinicId, code: 'OTRO', name: 'Otro', kind: 'INVENTARIO' });
  await H.makeProduct(clinicId, { code: '005', name: 'Zeta sin IVA', inventoryCategory: category._id, taxCategory: 'IVA_0', taxRate: 0 });
  await H.makeProduct(clinicId, { code: '002', name: 'Inhabilitado', inventoryCategory: category._id, disabled: true });
  await H.makeProduct(clinicId, { code: '003', name: 'Eliminado', inventoryCategory: category._id, active: false });
  await H.makeProduct(clinicId, { code: '004', name: 'Otra categoría', inventoryCategory: other._id });
  const response = await exportFile(
    H.mockReq(clinicId, userId, {}, { role: 'admin', params: { id: String(category._id) } }));
  assert.equal(response.statusCode, 200);
  const wb = await workbook(response.payload);
  const sheet = wb.getWorksheet('Ítems');
  const headers = sheet.getRow(6).values;
  const row = sheet.getRow(7);
  const col = (name) => headers.indexOf(name);
  assert.equal(sheet.rowCount, 8);
  assert.equal(row.getCell(col('Código')).value, '001');
  assert.equal(row.getCell(col('Nombre')).value, 'Ampolla activa');
  assert.equal(row.getCell(col('Precio de venta activo')).value, 29);
  assert.equal(row.getCell(col('IVA (%)')).value, 15);
  assert.equal(row.getCell(col('Precio incluye IVA')).value, 'Sí');
  assert.equal(row.getCell(col('Stock general')).value, 8);
  assert.equal(row.getCell(col('Costo promedio')).value, 4);
  assert.equal(sheet.getRow(8).getCell(col('IVA (%)')).value, 0);
  assert.equal(sheet.getRow(8).getCell(col('Tarifa tributaria')).value, 'IVA_0');
  assert.ok(sheet.autoFilter);
  const prices = wb.getWorksheet('Listas de precios');
  assert.equal(prices.rowCount, 6);
  assert.equal(prices.getRow(5).getCell(4).value, 25);
});

test('respeta el alcance de la categoría y no incluye costos sin permiso', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const other = await H.seedClinic();
  const product = await H.makeProduct(clinicId, { averageCost: 42 });
  const category = await InventoryCategory.findById(product.inventoryCategory);
  const makeReq = (clinic, role) => H.mockReq(clinic, userId, {}, { role, params: { id: String(category._id) } });
  const forbidden = await H.runController(controller.exportCategoryItems, makeReq(other.clinicId, 'admin'));
  assert.equal(forbidden.statusCode, 404);
  const response = await exportFile(makeReq(clinicId, 'cajero'));
  const wb = await workbook(response.payload);
  assert.equal(wb.getWorksheet('Ítems').getRow(6).values.includes('Costo promedio'), false);
});
