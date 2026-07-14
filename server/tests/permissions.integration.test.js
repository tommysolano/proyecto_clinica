/**
 * PERMISOS FINOS. La regla dura: ocultar una columna en React NO es un permiso — cualquiera abre
 * la pestaña de red y lee el costo. El BACKEND omite los importes para quien no puede verlos, y
 * su Excel tampoco los lleva.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/inventoryAdvancedController');
const reports = require('../controllers/salesReportsController');
const { can, canReq } = require('../utils/permissions');
const kardex = require('../utils/kardex');
const Warehouse = require('../models/Warehouse');
const InventoryMovement = require('../models/InventoryMovement');
const Product = require('../models/Product');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
/** `H.mockReq` con un ROL concreto (por defecto admin). */
const reqAs = (role, clinicId, userId, body = {}, extra = {}) =>
  H.mockReq(clinicId, userId, body, { ...extra, role });

async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const A = await Warehouse.create({ clinic: clinicId, code: 'A', name: 'Bodega A' });
  const prod = await H.makeProduct(clinicId, { code: 'P1', name: 'Insumo' });
  await kardex.receiveStock({
    clinicId, product: prod._id, warehouse: A._id, quantity: 10, unitCost: 7,
    date: new Date('2026-06-02'), sourceModel: 'PurchaseInvoice', sourceRef: prod._id, userId,
  });
  await InventoryMovement.create({
    clinic: clinicId, product: prod._id, type: 'entrada', warehouse: A._id, quantity: 10,
    unitCost: 7, totalCost: 70, movementDate: new Date('2026-06-02'), dateSource: 'DOCUMENTO',
    sourceModel: 'PurchaseInvoice', sourceRef: prod._id, createdBy: userId,
  });
  return { clinicId, userId, A, prod };
}

async function excelDe(handler, req) {
  const salida = new PassThrough();
  const chunks = [];
  salida.on('data', (c) => chunks.push(c));
  salida.setHeader = () => {};
  salida.status = () => ({ json: (p) => { throw new Error(`Falló: ${p.message}`); } });
  const fin = new Promise((r) => salida.on('end', r));
  await handler(req, salida);
  await fin;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  return wb;
}

// ═════════════════ CAPACIDADES ═════════════════

test('P1) el mapa de capacidades conserva los roles actuales', () => {
  assert.equal(can('admin', 'inventory.costs'), true);
  assert.equal(can('contabilidad', 'inventory.costs'), true);
  assert.equal(can('contabilidad', 'count.confirm'), true);
  assert.equal(can('cajero', 'inventory.view'), true, 'la caja puede ver existencias');
  assert.equal(can('cajero', 'inventory.costs'), false, 'pero no los costos');
  assert.equal(can('cajero', 'count.confirm'), false, 'ni confirmar el ajuste contable');
  assert.equal(can('cajero', 'inventory.export'), false);
  assert.equal(can('marketing', 'inventory.view'), false);
  assert.equal(can('enfermeria', 'count.start'), true);
  assert.equal(can('cualquiera', 'inventory.view'), false, 'un rol desconocido no tiene nada');
  assert.equal(canReq({ user: { isSuperAdmin: true } }, 'inventory.costs'), true);
});

// ═════════════════ KARDEX ═════════════════

test('P2) la API del kardex NO devuelve importes a un rol sin permiso de costos', async () => {
  const { clinicId, userId, prod } = await setup();
  const q = { query: { product: String(prod._id) } };

  const conCostos = ok(await run(ctrl.getKardex, reqAs('contabilidad', clinicId, userId, {}, q)));
  assert.equal(conCostos.saldoFinal.value, 70);
  assert.equal(conCostos.rows[0].unitCost, 7);

  const sinCostos = ok(await run(ctrl.getKardex, reqAs('cajero', clinicId, userId, {}, q)));
  assert.equal(sinCostos.costsHidden, true);
  assert.equal(sinCostos.saldoFinal.qty, 10, 'las CANTIDADES sí: se puede trabajar el inventario');
  assert.equal(sinCostos.saldoFinal.value, null, 'el importe NO SALE del servidor');
  assert.equal(sinCostos.saldoInicial.value, null);
  assert.equal(sinCostos.rows[0].unitCost, null);
  assert.equal(sinCostos.rows[0].entradaValor, null);
  assert.equal(sinCostos.rows[0].saldoValor, null);
  assert.equal(sinCostos.totales.entradasValor, null);
  assert.deepEqual(sinCostos.rows[0].layerConsumption, [], 'ni el costo de las capas consumidas');
  // La prueba de fuego: el costo no está en NINGÚN sitio de la respuesta.
  assert.ok(!JSON.stringify(sinCostos).includes('"unitCost":7'));
});

test('P3) el Excel del kardex sin permiso de costos no TIENE columnas de dinero', async () => {
  const { clinicId, userId, prod } = await setup();
  const q = { query: { product: String(prod._id) } };

  const wbAdmin = await excelDe(ctrl.kardexExcel, reqAs('contabilidad', clinicId, userId, {}, q));
  const cabAdmin = wbAdmin.getWorksheet('Kardex').getRow(1).values;
  assert.ok(cabAdmin.includes('Costo unitario'));
  assert.ok(cabAdmin.includes('Saldo ($)'));

  const wbCajero = await excelDe(ctrl.kardexExcel, reqAs('cajero', clinicId, userId, {}, q));
  const cab = wbCajero.getWorksheet('Kardex').getRow(1).values;
  assert.ok(!cab.includes('Costo unitario'), 'la columna no existe en el archivo');
  assert.ok(!cab.includes('Valor entrada'));
  assert.ok(!cab.includes('Saldo ($)'));
  assert.ok(cab.includes('Saldo (u)'), 'las cantidades sí');
});

// ═════════════════ TOMAS FÍSICAS ═════════════════

test('P4) una toma física sin permiso de costos viaja sin importes', async () => {
  const { clinicId, userId, A } = await setup();
  const body = { warehouse: String(A._id) };

  const conCostos = ok(await run(ctrl.startCount, reqAs('contabilidad', clinicId, userId, body)));
  assert.equal(conCostos.items[0].unitCost, 7);

  const sinCostos = ok(await run(ctrl.startCount, reqAs('cajero', clinicId, userId, body)));
  assert.equal(sinCostos.costsHidden, true);
  assert.equal(sinCostos.items[0].systemQty, 10, 'el contador ve las unidades');
  assert.equal(sinCostos.items[0].unitCost, null, 'pero no el costo');
  assert.equal(sinCostos.items[0].adjustmentValue, null);
});

test('P5) el conteo lo hace la bodega; CONFIRMAR el ajuste contable, no', async () => {
  const { clinicId, userId, A, prod } = await setup();
  const pc = ok(await run(ctrl.startCount, reqAs('cajero', clinicId, userId, { warehouse: String(A._id) })));
  ok(await run(ctrl.updateCount, reqAs('cajero', clinicId, userId,
    { items: [{ product: String(prod._id), countedQty: 8 }] }, { params: { id: String(pc._id) } })));

  // El middleware `requireCap('count.confirm')` es quien bloquea: se comprueba la capacidad.
  assert.equal(can('cajero', 'count.confirm'), false);
  assert.equal(can('contabilidad', 'count.confirm'), true);

  // Y contabilidad sí puede cerrarla.
  const r = ok(await run(ctrl.confirmCount, reqAs('contabilidad', clinicId, userId,
    { date: '2026-06-15' }, { params: { id: String(pc._id) } })));
  assert.equal(r.status, 'CONFIRMADO');
  const enBodega = await kardex.currentStock({ clinicId, product: prod._id, warehouse: A._id });
  assert.equal(enBodega.qty, 8);
});

// ═════════════════ VENTAS ═════════════════

test('P6) los presets y la exportación de ventas son de admin/contabilidad', () => {
  assert.equal(can('contabilidad', 'sales.presets'), true);
  assert.equal(can('contabilidad', 'sales.export'), true);
  assert.equal(can('cajero', 'sales.report'), true, 'la caja puede CONSULTAR el reporte');
  assert.equal(can('cajero', 'sales.presets'), false, 'pero no gestionar presets');
  assert.equal(can('cajero', 'sales.export'), false, 'ni exportarlo');
  assert.equal(can('marketing', 'sales.report'), true);
  assert.equal(can('marketing', 'sales.export'), false);
});

test('P7) el reporte de ventas responde igual para cualquier rol que pueda consultarlo', async () => {
  const { clinicId, userId } = await setup();
  await Product.updateMany({ clinic: clinicId }, { $set: { categoria: 'Insumos' } });
  const admin = ok(await run(reports.report, reqAs('admin', clinicId, userId, {}, { query: {} })));
  const caja = ok(await run(reports.report, reqAs('cajero', clinicId, userId, {}, { query: {} })));
  assert.deepEqual(caja.resumen, admin.resumen, 'el reporte de ventas no expone costos ni márgenes');
});
