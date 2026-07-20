/**
 * CENTRO DE COSTO DE LA BODEGA en COMPRAS y VENTAS.
 *
 * La regla (`services/costCenterPolicy`): la bodega PROPONE su centro, el documento MANDA, y una
 * diferencia sin confirmar se RECHAZA. Aquí se verifica que el centro que se usó de verdad sea el
 * mismo en los cuatro sitios donde se puede mentir: la compra/venta, el movimiento de inventario,
 * la capa FIFO y el asiento (y, en compras, el activo fijo que nace de la línea).
 *
 * Y se cierra un bug real: la venta NUNCA copiaba la bodega a sus líneas, así que consumía capas
 * FIFO de cualquier bodega y su salida no aparecía en el kardex de ninguna.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const sales = require('../controllers/saleController');
const payments = require('../controllers/paymentController');
const reports = require('../controllers/salesReportsController');
const invCtrl = require('../controllers/inventoryAdvancedController');
const kardex = require('../utils/kardex');
const { buildKardex } = require('../services/kardexService');

const Warehouse = require('../models/Warehouse');
const CostCenter = require('../models/CostCenter');
const InventoryCategory = require('../models/InventoryCategory');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryLayer = require('../models/InventoryLayer');
const ChartOfAccount = require('../models/ChartOfAccount');
const JournalEntry = require('../models/JournalEntry');
const FixedAsset = require('../models/FixedAsset');
const AuditLog = require('../models/AuditLog');
const Sale = require('../models/Sale');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const idOf = (v) => String(v && typeof v === 'object' ? (v._id ?? v) : (v ?? ''));

/**
 * Clínica con DOS centros de costo y una bodega cuyo centro predeterminado es el primero.
 * `otra` es un centro válido pero distinto: es el que dispara la confirmación.
 */
async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const ccQuiro = await CostCenter.create({ clinic: clinicId, code: 'CC-QX', name: 'Quirófano' });
  const ccEstetica = await CostCenter.create({ clinic: clinicId, code: 'CC-ES', name: 'Estética' });
  const ccInactivo = await CostCenter.create({ clinic: clinicId, code: 'CC-OFF', name: 'Cerrado', active: false });
  const bodega = await Warehouse.create({ clinic: clinicId, code: 'B1', name: 'Bodega Quirófano', costCenter: ccQuiro._id });
  const bodega2 = await Warehouse.create({ clinic: clinicId, code: 'B2', name: 'Bodega Estética', costCenter: ccEstetica._id });
  const sup = await H.makeSupplier(clinicId);
  return { clinicId, userId, ccQuiro, ccEstetica, ccInactivo, bodega, bodega2, sup };
}

const invLine = (productId, warehouseId, { qty = 10, unit = 5, costCenter = null } = {}) => ({
  description: 'Insumo', lineType: 'INVENTARIO', product: productId, warehouse: warehouseId,
  quantity: qty, unitPrice: unit, ivaRate: 0, subtotal: +(qty * unit).toFixed(2),
  ...(costCenter ? { costCenter } : {}),
});

const crearCompra = (clinicId, userId, sup, items, extra = {}) => run(purchase.create, H.mockReq(clinicId, userId, {
  supplier: sup._id, fechaEmision: new Date('2026-06-05'), serie: `001-001-${Math.floor(Math.random() * 1e9)}`,
  items, ...extra,
}));

const crearVenta = (clinicId, userId, body) => run(sales.createSale, H.mockReq(clinicId, userId, {
  date: new Date('2026-06-10'), paymentMethod: 'efectivo', ...body,
}));

/** Asiento de un documento (el único CONTABILIZADO que lo referencia). */
const asientoDe = (clinicId, sourceModel, sourceRef) => JournalEntry.findOne({
  clinic: clinicId, sourceModel, sourceRef, source: { $in: ['COMPRA', 'VENTA'] }, status: 'CONTABILIZADO',
});
// Todos los asientos del documento (una venta genera DOS: venta POST + costo POST_COST).
const asientosDe = (clinicId, sourceModel, sourceRef) => JournalEntry.find({
  clinic: clinicId, sourceModel, sourceRef, source: { $in: ['COMPRA', 'VENTA'] }, status: 'CONTABILIZADO',
}).sort({ createdAt: 1 });

// ══════════════════════════════ COMPRAS ══════════════════════════════

test('1) la compra PROPONE el centro de costo de la bodega elegida', async () => {
  const { clinicId, userId, bodega, ccQuiro, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1' });

  // La línea NO trae centro: lo pone la bodega.
  const inv = ok(await crearCompra(clinicId, userId, sup, [invLine(prod._id, bodega._id)]));

  assert.equal(idOf(inv.items[0].costCenter), String(ccQuiro._id), 'la bodega propuso su centro');
});

test('2) la compra CONSERVA el centro ya elegido: no se pisa con el de la bodega', async () => {
  const { clinicId, userId, bodega, ccQuiro, ccEstetica, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1' });

  const inv = ok(await crearCompra(clinicId, userId, sup,
    [invLine(prod._id, bodega._id, { costCenter: ccEstetica._id })],
    { costCenterConfirmed: true }));

  assert.equal(idOf(inv.items[0].costCenter), String(ccEstetica._id), 'manda el documento');
  assert.notEqual(idOf(inv.items[0].costCenter), String(ccQuiro._id));
});

test('3) un centro distinto al de la bodega SIN confirmar se rechaza (409 controlado)', async () => {
  const { clinicId, userId, bodega, ccQuiro, ccEstetica, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1' });

  const r = await crearCompra(clinicId, userId, sup,
    [invLine(prod._id, bodega._id, { costCenter: ccEstetica._id })]);

  assert.equal(r.statusCode, 409);
  assert.equal(r.payload.code, 'COST_CENTER_MISMATCH');
  assert.equal(r.payload.warehouse.name, 'Bodega Quirófano', 'dice QUÉ bodega');
  assert.equal(r.payload.esperado._id, String(ccQuiro._id), 'y qué centro esperaba');
  assert.equal(r.payload.elegido._id, String(ccEstetica._id), 'y cuál se eligió');
  // Y no se contabilizó nada a medias.
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId }), 0);
});

test('4) confirmada, la diferencia se acepta y queda AUDITADA', async () => {
  const { clinicId, userId, bodega, ccEstetica, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1' });

  const inv = ok(await crearCompra(clinicId, userId, sup,
    [invLine(prod._id, bodega._id, { costCenter: ccEstetica._id })],
    { costCenterConfirmed: true }));

  const log = await AuditLog.findOne({ clinic: clinicId, entity: 'purchase-invoices', entityId: String(inv._id) });
  assert.ok(log, 'la diferencia aceptada no puede desaparecer: queda en auditoría');
  assert.match(log.description, /centro de costo distinto/i);
  assert.match(log.description, /Bodega Quirófano/);
});

test('5) el ACTIVO FIJO hereda el centro de costo realmente usado', async () => {
  const { clinicId, userId, bodega, ccEstetica, sup } = await setup();
  const assetAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.05.10', name: 'Equipos', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const depAcc = await ChartOfAccount.create({ clinic: clinicId, code: '5.2.10', name: 'Gasto dep.', type: 'GASTO', nature: 'DEBITO', allowsMovement: true });
  const accumAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.90.10', name: 'Dep. acum.', type: 'ACTIVO', nature: 'CREDITO', allowsMovement: true });
  const cat = await InventoryCategory.create({
    clinic: clinicId, code: 'AF-EQ', name: 'Equipos', kind: 'ACTIVO_FIJO',
    assetAccount: assetAcc._id, depreciationAccount: depAcc._id, accumDepreciationAccount: accumAcc._id,
    usefulLifeMonths: 10, residualPercent: 0, expenseType: 'ADMINISTRATIVO',
  });

  const inv = ok(await crearCompra(clinicId, userId, sup, [{
    description: 'Monitor', lineType: 'ACTIVO_FIJO', quantity: 2, unitPrice: 500, ivaRate: 0, subtotal: 1000,
    warehouse: bodega._id, costCenter: ccEstetica._id, fixedAsset: { category: cat._id, name: 'Monitor' },
  }], { costCenterConfirmed: true }));

  const activos = await FixedAsset.find({ clinic: clinicId, purchaseInvoice: inv._id });
  assert.equal(activos.length, 2);
  for (const a of activos) {
    assert.equal(idOf(a.costCenter), String(ccEstetica._id), 'el activo lleva el centro elegido, no el de la bodega');
    assert.equal(idOf(a.warehouse), String(bodega._id));
  }
});

test('6) el MOVIMIENTO, la CAPA y el ASIENTO de la compra llevan el MISMO centro', async () => {
  const { clinicId, userId, bodega, ccQuiro, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1' });

  const inv = ok(await crearCompra(clinicId, userId, sup, [invLine(prod._id, bodega._id, { qty: 10, unit: 5 })]));

  const mov = await InventoryMovement.findOne({ clinic: clinicId, sourceRef: inv._id, type: 'entrada' });
  const capa = await InventoryLayer.findOne({ clinic: clinicId, product: prod._id });
  const asiento = await asientoDe(clinicId, 'PurchaseInvoice', inv._id);

  assert.equal(idOf(mov.costCenter), String(ccQuiro._id), 'movimiento');
  assert.equal(idOf(mov.warehouse), String(bodega._id), 'el movimiento sabe DÓNDE entró');
  assert.equal(mov.dateSource, 'DOCUMENTO', 'y se fecha por el comprobante, no por createdAt');
  assert.equal(idOf(capa.costCenter), String(ccQuiro._id), 'capa FIFO');
  assert.equal(idOf(capa.warehouse), String(bodega._id));
  const linea = asiento.lines.find((l) => l.debit > 0);
  assert.equal(idOf(linea.costCenter), String(ccQuiro._id), 'asiento');
});

// ══════════════════════════════ VENTAS ══════════════════════════════

/** Deja `qty` unidades del producto en la bodega, compradas a `unit`. */
async function comprarEn(clinicId, userId, sup, prod, bodega, { qty = 10, unit = 5 } = {}) {
  return ok(await crearCompra(clinicId, userId, sup, [invLine(prod._id, bodega._id, { qty, unit })]));
}

test('7) la venta PROPONE el centro de la bodega', async () => {
  const { clinicId, userId, bodega, ccQuiro, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  await comprarEn(clinicId, userId, sup, prod, bodega);

  const venta = ok(await crearVenta(clinicId, userId, {
    warehouse: String(bodega._id),
    items: [{ product: String(prod._id), quantity: 2, unitPrice: 20 }],
  }));

  assert.equal(idOf(venta.costCenter), String(ccQuiro._id));
  assert.equal(idOf(venta.warehouse), String(bodega._id));
});

test('8) la venta con centro distinto SIN confirmar se rechaza', async () => {
  const { clinicId, userId, bodega, ccEstetica, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  await comprarEn(clinicId, userId, sup, prod, bodega);

  const r = await crearVenta(clinicId, userId, {
    warehouse: String(bodega._id), costCenter: String(ccEstetica._id),
    items: [{ product: String(prod._id), quantity: 2, unitPrice: 20 }],
  });

  assert.equal(r.statusCode, 409);
  assert.equal(r.payload.code, 'COST_CENTER_MISMATCH');
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0, 'no se creó la venta a medias');
});

test('9) confirmada, la venta registra el centro ELEGIDO', async () => {
  const { clinicId, userId, bodega, ccEstetica, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  await comprarEn(clinicId, userId, sup, prod, bodega);

  const venta = ok(await crearVenta(clinicId, userId, {
    warehouse: String(bodega._id), costCenter: String(ccEstetica._id), costCenterConfirmed: true,
    items: [{ product: String(prod._id), quantity: 2, unitPrice: 20 }],
  }));

  assert.equal(idOf(venta.costCenter), String(ccEstetica._id));
  const log = await AuditLog.findOne({ clinic: clinicId, entity: 'sales', entityId: String(venta._id) });
  assert.ok(log, 'y la diferencia queda auditada');
});

test('10) el asiento de INGRESO y el de COSTO (COGS) llevan el centro de la venta', async () => {
  const { clinicId, userId, bodega, ccQuiro, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  await comprarEn(clinicId, userId, sup, prod, bodega, { qty: 10, unit: 5 });

  const venta = ok(await crearVenta(clinicId, userId, {
    warehouse: String(bodega._id),
    items: [{ product: String(prod._id), quantity: 2, unitPrice: 20 }],
  }));

  // DOS asientos: venta (POST) y costo (POST_COST). El centro va en TODAS las líneas de AMBOS.
  const asientos = await asientosDe(clinicId, 'Sale', venta._id);
  assert.equal(asientos.length, 2, 'venta genera asiento de venta y asiento de costo');
  const allLines = asientos.flatMap((a) => a.lines);
  assert.ok(allLines.length >= 4);
  for (const l of allLines) {
    assert.equal(idOf(l.costCenter), String(ccQuiro._id), `la línea "${l.description}" debe llevar el centro`);
  }
  // El COGS es el real del FIFO: 2 × 5, y vive en el asiento de costo (POST_COST).
  const costEntry = asientos.find((a) => a.sourceAction === 'POST_COST');
  const cogs = costEntry.lines.find((l) => /Costo venta/i.test(l.description));
  assert.equal(cogs.debit, 10);

  // El movimiento de salida también: misma bodega, mismo centro, y con su asiento (el de costo).
  const mov = await InventoryMovement.findOne({ clinic: clinicId, sourceRef: venta._id, type: 'salida' });
  assert.equal(idOf(mov.warehouse), String(bodega._id), 'la salida sale de SU bodega');
  assert.equal(idOf(mov.costCenter), String(ccQuiro._id));
  assert.equal(idOf(mov.journalEntry), String(costEntry._id), 'trazabilidad kardex → asiento de costo');
});

test('11) un SERVICIO sin bodega no recibe un centro inventado', async () => {
  const { clinicId, userId } = await setup();
  const serv = await H.makeProduct(clinicId, { code: 'S1', name: 'Consulta', category: 'servicio', unlimited: true, price: 30 });

  const venta = ok(await crearVenta(clinicId, userId, {
    items: [{ product: String(serv._id), quantity: 1, unitPrice: 30 }],
  }));

  assert.equal(venta.costCenter, null, 'sin bodega no hay centro de bodega que proponer');
  assert.equal(venta.warehouse, null);
  assert.equal(venta.items[0].warehouse, null, 'y el servicio no sale de ninguna bodega');
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, sourceRef: venta._id }), 0);
});

// ══════════════════════════════ VALIDACIONES ══════════════════════════════

test('12) un centro de OTRA clínica se rechaza', async () => {
  const { clinicId, userId, bodega, sup } = await setup();
  const otra = await setup();          // otra clínica, con sus propios centros
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  await comprarEn(clinicId, userId, sup, prod, bodega);

  const r = await crearVenta(clinicId, userId, {
    warehouse: String(bodega._id), costCenter: String(otra.ccEstetica._id), costCenterConfirmed: true,
    items: [{ product: String(prod._id), quantity: 1, unitPrice: 20 }],
  });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no existe en esta clínica/i);
});

test('13) un centro INACTIVO se rechaza', async () => {
  const { clinicId, userId, bodega, ccInactivo, sup } = await setup();
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  await comprarEn(clinicId, userId, sup, prod, bodega);

  const r = await crearVenta(clinicId, userId, {
    warehouse: String(bodega._id), costCenter: String(ccInactivo._id), costCenterConfirmed: true,
    items: [{ product: String(prod._id), quantity: 1, unitPrice: 20 }],
  });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /inactivo/i);
});

test('14) una BODEGA inactiva se rechaza', async () => {
  const { clinicId, userId, sup } = await setup();
  const cerrada = await Warehouse.create({ clinic: clinicId, code: 'B9', name: 'Bodega cerrada', active: false });
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });

  const r = await crearCompra(clinicId, userId, sup, [invLine(prod._id, cerrada._id)]);
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /inactiva/i);
});

// ══════════════════════════════ REPORTES ══════════════════════════════

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

/** Dos ventas: una en cada bodega (y por tanto en cada centro). */
async function dosVentasEnDosCentros(s) {
  const { clinicId, userId, bodega, bodega2, sup } = s;
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20, categoria: 'Insumos' });
  await comprarEn(clinicId, userId, sup, prod, bodega, { qty: 10, unit: 5 });
  await comprarEn(clinicId, userId, sup, prod, bodega2, { qty: 10, unit: 5 });
  const vQuiro = ok(await crearVenta(clinicId, userId, {
    warehouse: String(bodega._id), items: [{ product: String(prod._id), quantity: 2, unitPrice: 20 }],
  }));
  const vEstetica = ok(await crearVenta(clinicId, userId, {
    warehouse: String(bodega2._id), items: [{ product: String(prod._id), quantity: 3, unitPrice: 20 }],
  }));
  return { prod, vQuiro, vEstetica };
}

test('15) el reporte FILTRA por centro de costo (antes se recibía el filtro y se ignoraba)', async () => {
  const s = await setup();
  const { vQuiro } = await dosVentasEnDosCentros(s);

  const todo = ok(await run(reports.report, H.mockReq(s.clinicId, s.userId, {}, { query: {} })));
  assert.equal(todo.documentos.length, 2);

  const soloQuiro = ok(await run(reports.report, H.mockReq(s.clinicId, s.userId, {},
    { query: { costCenter: String(s.ccQuiro._id) } })));
  assert.equal(soloQuiro.documentos.length, 1, 'solo la venta de ese centro');
  assert.equal(soloQuiro.documentos[0].numero, vQuiro.saleNumber);
  assert.equal(soloQuiro.documentos[0].costCenterName, 'CC-QX - Quirófano', 'y se ve el NOMBRE, no un id');
  // El resumen del centro filtrado es su propio total (2 × 20 = 40 con IVA incluido).
  assert.equal(soloQuiro.resumen.total, soloQuiro.documentos[0].total);
  assert.deepEqual(Object.keys(soloQuiro.resumen.porCentroCosto), ['CC-QX - Quirófano']);
});

test('16) el EXCEL usa el mismo filtro y concilia con la API', async () => {
  const s = await setup();
  await dosVentasEnDosCentros(s);
  const query = { costCenter: String(s.ccEstetica._id) };

  const api = ok(await run(reports.report, H.mockReq(s.clinicId, s.userId, {}, { query })));
  const wb = await excelDe(reports.exportReportExcel, H.mockReq(s.clinicId, s.userId, {}, { query }));
  const ws = wb.getWorksheet('Ventas');

  // Cabecera + 1 documento (el otro centro NO está en el archivo).
  assert.equal(ws.rowCount, 2, 'el Excel trae los mismos documentos que la API');
  assert.equal(api.documentos.length, 1);
  const fila = ws.getRow(2).values;
  assert.ok(fila.includes('CC-ES - Estética'), 'con el nombre del centro');
  const totalExcel = ws.getRow(2).getCell(11).value;   // columna "Total"
  assert.equal(totalExcel, api.documentos[0].total, 'y el mismo total');
});

// ══════════════════════════════ PERMISOS ══════════════════════════════

test('17) un rol sin permiso de costos no recibe importes del kardex (ni con bodega)', async () => {
  const s = await setup();
  const { clinicId, userId, bodega, sup } = s;
  const prod = await H.makeProduct(clinicId, { code: 'P1' });
  await comprarEn(clinicId, userId, sup, prod, bodega, { qty: 10, unit: 7 });

  const q = { query: { product: String(prod._id), warehouse: String(bodega._id) } };
  const conCostos = ok(await run(invCtrl.getKardex, H.mockReq(clinicId, userId, {}, { ...q, role: 'contabilidad' })));
  assert.equal(conCostos.saldoFinal.value, 70);

  const sinCostos = ok(await run(invCtrl.getKardex, H.mockReq(clinicId, userId, {}, { ...q, role: 'cajero' })));
  assert.equal(sinCostos.costsHidden, true);
  assert.equal(sinCostos.saldoFinal.qty, 10, 'las cantidades sí');
  assert.equal(sinCostos.saldoFinal.value, null);
  assert.ok(!JSON.stringify(sinCostos).includes('"unitCost":7'), 'el costo no viaja en NINGUNA parte');
});

test('18) el cajero puede contar pero NO confirmar la toma (el ajuste es contable)', async () => {
  const { can } = require('../utils/permissions');
  assert.equal(can('cajero', 'count.start'), true);
  assert.equal(can('cajero', 'count.confirm'), false);
  assert.equal(can('contabilidad', 'count.confirm'), true);
});

// ══════════════════════════════ TRAZABILIDAD Y AISLAMIENTO ══════════════════════════════

test('19) trazabilidad: desde el kardex se llega a la compra, a la venta y a sus asientos', async () => {
  const s = await setup();
  const { clinicId, userId, bodega, sup } = s;
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  const inv = await comprarEn(clinicId, userId, sup, prod, bodega, { qty: 10, unit: 5 });
  const venta = ok(await crearVenta(clinicId, userId, {
    warehouse: String(bodega._id), items: [{ product: String(prod._id), quantity: 4, unitPrice: 20 }],
  }));

  const k = await buildKardex(clinicId, { product: prod._id, warehouse: bodega._id });
  assert.equal(k.rows.length, 2, 'la entrada de la compra y la salida de la venta, en SU bodega');

  const entrada = k.rows.find((r) => r.documento?.model === 'PurchaseInvoice');
  const salida = k.rows.find((r) => r.documento?.model === 'Sale');
  assert.equal(String(entrada.documento.ref), String(inv._id), 'el kardex apunta a la compra');
  assert.equal(String(salida.documento.ref), String(venta._id), 'y a la venta');
  assert.ok(entrada.journalEntry, 'y cada uno a su asiento');
  assert.ok(salida.journalEntry);

  // CONCILIACIÓN del kardex: saldo inicial + entradas − salidas = saldo final (unidades y valor).
  assert.equal(k.saldoInicial.qty + k.totales.entradasQty - k.totales.salidasQty, k.saldoFinal.qty);
  assert.equal(
    +(k.saldoInicial.value + k.totales.entradasValor - k.totales.salidasValor).toFixed(2),
    k.saldoFinal.value
  );
  assert.equal(k.saldoFinal.qty, 6);
  assert.equal(k.saldoFinal.value, 30, '6 × 5');
  assert.equal(k.totales.cuadra, true);

  // Y el submayor de la bodega dice lo mismo que el kardex.
  const enBodega = await kardex.currentStock({ clinicId, product: prod._id, warehouse: bodega._id });
  assert.equal(enBodega.qty, 6);

  const { balanced } = await H.assertLedgerBalanced(clinicId);
  assert.equal(balanced, true);
});

test('20) dos clínicas: cada una con su bodega, su centro y su reporte', async () => {
  const a = await setup();
  const b = await setup();

  const pa = await H.makeProduct(a.clinicId, { code: 'P1', price: 20, categoria: 'Insumos' });
  const pb = await H.makeProduct(b.clinicId, { code: 'P1', price: 20, categoria: 'Insumos' });
  await comprarEn(a.clinicId, a.userId, a.sup, pa, a.bodega, { qty: 5, unit: 5 });
  await comprarEn(b.clinicId, b.userId, b.sup, pb, b.bodega, { qty: 5, unit: 9 });
  const va = ok(await crearVenta(a.clinicId, a.userId, {
    warehouse: String(a.bodega._id), items: [{ product: String(pa._id), quantity: 1, unitPrice: 20 }],
  }));
  ok(await crearVenta(b.clinicId, b.userId, {
    warehouse: String(b.bodega._id), items: [{ product: String(pb._id), quantity: 2, unitPrice: 20 }],
  }));

  const rA = ok(await run(reports.report, H.mockReq(a.clinicId, a.userId, {}, { query: {} })));
  assert.equal(rA.documentos.length, 1, 'la clínica A solo ve lo suyo');
  assert.equal(rA.documentos[0].numero, va.saleNumber);

  const kB = await buildKardex(b.clinicId, { product: pb._id, warehouse: b.bodega._id });
  assert.equal(kB.saldoFinal.qty, 3);
  assert.equal(kB.saldoFinal.value, 27, 'y su propio costo (3 × 9)');
});

// ════════════════════ EL BUG QUE ESTO CIERRA (regresión) ════════════════════

test('21) REGRESIÓN: la venta consume las capas de SU bodega, no las de cualquiera', async () => {
  const s = await setup();
  const { clinicId, userId, bodega, bodega2, sup } = s;
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  // Misma mercadería en dos bodegas, con costos distintos.
  await comprarEn(clinicId, userId, sup, prod, bodega, { qty: 5, unit: 5 });    // Quirófano @5
  await comprarEn(clinicId, userId, sup, prod, bodega2, { qty: 5, unit: 11 });  // Estética  @11

  // Se vende desde ESTÉTICA: el costo tiene que ser el de Estética (11), no el más viejo (5).
  const venta = ok(await crearVenta(clinicId, userId, {
    warehouse: String(bodega2._id), costCenter: String(s.ccEstetica._id),
    items: [{ product: String(prod._id), quantity: 2, unitPrice: 20 }],
  }));

  const asientos = await asientosDe(clinicId, 'Sale', venta._id);
  const cogs = asientos.flatMap((a) => a.lines).find((l) => /Costo venta/i.test(l.description));
  assert.equal(cogs.debit, 22, 'FIFO DENTRO de la bodega: 2 × 11');

  const enQuiro = await kardex.currentStock({ clinicId, product: prod._id, warehouse: bodega._id });
  const enEstetica = await kardex.currentStock({ clinicId, product: prod._id, warehouse: bodega2._id });
  assert.equal(enQuiro.qty, 5, 'la otra bodega NO se tocó');
  assert.equal(enEstetica.qty, 3);
});

test('22) no se puede vender de una bodega que no tiene el stock (aunque el total alcance)', async () => {
  const s = await setup();
  const { clinicId, userId, bodega, bodega2, sup } = s;
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  await comprarEn(clinicId, userId, sup, prod, bodega, { qty: 10, unit: 5 });   // 10 en Quirófano
  await comprarEn(clinicId, userId, sup, prod, bodega2, { qty: 2, unit: 5 });   // 2 en Estética

  // En total hay 12, pero en Estética solo 2: vender 5 desde Estética NO puede pasar.
  const r = await crearVenta(clinicId, userId, {
    warehouse: String(bodega2._id), costCenter: String(s.ccEstetica._id),
    items: [{ product: String(prod._id), quantity: 5, unitPrice: 20 }],
  });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /bodega seleccionada/i);
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0);
});

test('23) un COBRO posterior no reclasifica el centro de costo de la venta', async () => {
  const s = await setup();
  const { clinicId, userId, bodega, ccQuiro, sup } = s;
  const prod = await H.makeProduct(clinicId, { code: 'P1', price: 20 });
  await comprarEn(clinicId, userId, sup, prod, bodega, { qty: 10, unit: 5 });

  const venta = ok(await crearVenta(clinicId, userId, {
    warehouse: String(bodega._id), paymentMethod: 'credito',
    items: [{ product: String(prod._id), quantity: 2, unitPrice: 20 }],
  }));
  assert.ok(venta.balance > 0);

  const acc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const BankAccount = require('../models/BankAccount');
  const bank = await BankAccount.create({
    clinic: clinicId, name: 'Cta', bank: 'Pichincha', accountNumber: '123', chartAccount: acc._id,
  });
  ok(await run(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'TRANSFERENCIA', partyModel: 'Patient', partyName: 'Cliente',
    date: new Date('2026-06-15'), bankAccount: String(bank._id),
    applications: [{ docModel: 'Sale', docRef: String(venta._id), amount: venta.balance }],
  })));

  const despues = await Sale.findById(venta._id);
  assert.equal(idOf(despues.costCenter), String(ccQuiro._id), 'el cobro no toca el centro de la venta');
  assert.equal(despues.balance, 0);
  const { balanced } = await H.assertLedgerBalanced(clinicId);
  assert.equal(balanced, true);
});
