/**
 * TOMA FÍSICA: eliminar un BORRADOR (nov-2026). Un borrador no movió nada (el ajuste ocurre al
 * confirmar), así que se borra de verdad; una toma confirmada no. Y la numeración ya no cuenta
 * las tomas: después de borrar una no se repite un código (el índice (clinic, code) es único).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/inventoryAdvancedController');
const PhysicalCount = require('../models/PhysicalCount');
const Warehouse = require('../models/Warehouse');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const toma = (clinic, code, status, warehouse) => ({ clinic, code, status, warehouse, date: new Date(), items: [] });

test('se elimina un borrador; una toma confirmada no', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wh = await Warehouse.create({ clinic: clinicId, code: 'BOD001', name: 'Matriz' });
  const [confirmada, borrador] = await PhysicalCount.create([
    toma(clinicId, 'TF-00001', 'CONFIRMADO', wh._id),
    toma(clinicId, 'TF-00002', 'BORRADOR', wh._id),
  ]);

  const r = await H.runController(ctrl.deleteCount, H.mockReq(clinicId, userId, {}, { params: { id: String(borrador._id) } }));
  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  assert.equal(await PhysicalCount.countDocuments({ _id: borrador._id }), 0);

  const no = await H.runController(ctrl.deleteCount, H.mockReq(clinicId, userId, {}, { params: { id: String(confirmada._id) } }));
  assert.equal(no.statusCode, 400);
  assert.equal(await PhysicalCount.countDocuments({ _id: confirmada._id }), 1, 'la confirmada sigue ahí');
});

test('después de eliminar un borrador, la toma nueva no repite código', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wh = await Warehouse.create({ clinic: clinicId, code: 'BOD001', name: 'Matriz' });
  const [, medio] = await PhysicalCount.create([
    toma(clinicId, 'TF-00001', 'CONFIRMADO', wh._id),
    toma(clinicId, 'TF-00002', 'BORRADOR', wh._id),
    toma(clinicId, 'TF-00003', 'CONFIRMADO', wh._id),
  ]);
  await H.runController(ctrl.deleteCount, H.mockReq(clinicId, userId, {}, { params: { id: String(medio._id) } }));

  const r = await H.runController(ctrl.startCount, H.mockReq(clinicId, userId, { warehouse: String(wh._id) }));
  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  assert.equal(r.payload.code, 'TF-00004', 'sigue al número más alto, no a cuántas hay');
});

test('toma de UNA categoría: la toma y su Excel traen solo esos productos', async () => {
  const ExcelJS = require('exceljs');
  const { Writable } = require('node:stream');
  const InventoryCategory = require('../models/InventoryCategory');
  const { clinicId, userId } = await H.seedClinic();
  const wh = await Warehouse.create({ clinic: clinicId, code: 'BOD001', name: 'Matriz' });
  // El primer producto crea la categoría contable por defecto (INV-DEF): la otra copia sus cuentas.
  await H.makeProduct(clinicId, { code: 'SUM-1', name: 'Suministro', active: true });
  const base = await InventoryCategory.findOne({ clinic: clinicId, code: 'INV-DEF' });
  const ampollas = await InventoryCategory.create({
    clinic: clinicId, code: 'AMP', name: 'AMPOLLAS', kind: 'INVENTARIO',
    assetAccount: base.assetAccount, expenseAccount: base.expenseAccount, incomeAccount: base.incomeAccount,
  });
  await H.makeProduct(clinicId, { code: 'AMP-1', name: 'Ampolla 1', active: true, inventoryCategory: ampollas._id });
  await H.makeProduct(clinicId, { code: 'AMP-2', name: 'Ampolla 2', active: true, inventoryCategory: ampollas._id });

  const r = await H.runController(ctrl.startCount, H.mockReq(clinicId, userId, { warehouse: String(wh._id), category: String(ampollas._id) }));
  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  assert.deepEqual(r.payload.items.map((it) => it.productCode).sort(), ['AMP-1', 'AMP-2']);
  assert.equal(r.payload.category?.name, 'AMPOLLAS', 'la respuesta trae el nombre de la categoría');

  const chunks = [];
  const res = new Writable({ write(c, _e, cb) { chunks.push(Buffer.from(c)); cb(); } });
  res.setHeader = () => {};
  res.status = () => res;
  res.json = (p) => { throw new Error(JSON.stringify(p)); };
  const fin = new Promise((resolve) => res.on('finish', resolve));
  await ctrl.downloadCountSheet(H.mockReq(clinicId, userId, {}, { params: { id: String(r.payload._id) } }), res);
  await fin;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  const codigos = [];
  wb.getWorksheet('Toma fisica').eachRow((row, n) => { if (n > 1) codigos.push(row.getCell(1).value); });
  assert.deepEqual(codigos.sort(), ['AMP-1', 'AMP-2'], 'el Excel no trae productos de otras categorías');
  const datos = wb.getWorksheet('Datos de la toma');
  assert.equal(datos.getRow(1).getCell(2).value, r.payload.code, 'el código sigue en la fila 1 (lo valida la subida)');
  const filaCat = [1, 2, 3, 4].map((n) => datos.getRow(n)).find((row) => row.getCell(1).value === 'Categoría');
  assert.equal(filaCat?.getCell(2).value, 'AMPOLLAS');
});
