/**
 * Activos fijos por CATEGORÍA: la categoría es la única fuente de la configuración
 * contable y de depreciación. Compras y creación manual copian un snapshot; no se
 * editan cuentas ni parámetros desde la factura ni desde el activo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const inv = require('../controllers/inventoryAdvancedController');
const purchase = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const FixedAsset = require('../models/FixedAsset');
const JournalEntry = require('../models/JournalEntry');
const FiscalPeriod = require('../models/FiscalPeriod');
const fiscal = require('../controllers/fiscalPeriodController');
const { getOrCreatePeriod } = require('../utils/accounting');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// Los comprobantes ya no admiten fecha anterior a hoy (utils/fiscalDocumentDate), así que
// estas pruebas trabajan sobre HOY y el MES EN CURSO en vez de sobre un mes fijo del calendario.
const Y = new Date().getFullYear();
const M = new Date().getMonth() + 1;

async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const assetAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.05.10', name: 'Equipos de computación', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const depAcc = await ChartOfAccount.create({ clinic: clinicId, code: '5.2.10', name: 'Gasto depreciación', type: 'GASTO', nature: 'DEBITO', allowsMovement: true });
  const accumAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.90.10', name: 'Depreciación acumulada', type: 'ACTIVO', nature: 'CREDITO', allowsMovement: true });
  const noMov = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.00', name: 'Grupo (no mov)', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: false });
  // Categoría completa y depreciable: vida útil 10 meses, sin residual → dep mensual = costo/10.
  const cat = await InventoryCategory.create({
    clinic: clinicId, code: 'AF-PC', name: 'Equipos de computación', kind: 'ACTIVO_FIJO',
    assetAccount: assetAcc._id, depreciationAccount: depAcc._id, accumDepreciationAccount: accumAcc._id,
    usefulLifeMonths: 10, residualPercent: 0, expenseType: 'ADMINISTRATIVO',
  });
  return { clinicId, userId, assetAcc, depAcc, accumAcc, noMov, cat };
}

const afLine = (catId, val = 1000) => ({ description: 'Laptop', lineType: 'ACTIVO_FIJO', quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val, fixedAsset: { category: catId, name: 'Laptop' } });

// ── Categorías ─────────────────────────────────────────────────────────────────
test('1) crea categoría de activo fijo válida', async () => {
  const { clinicId, userId, assetAcc, depAcc, accumAcc } = await setup();
  const r = await H.runController(inv.createCategory, H.mockReq(clinicId, userId, {
    code: 'AF-VEH', name: 'Vehículos', kind: 'ACTIVO_FIJO', assetAccount: String(assetAcc._id), depreciationAccount: String(depAcc._id), accumDepreciationAccount: String(accumAcc._id), usefulLifeMonths: 60, residualPercent: 10, expenseType: 'VENTAS',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.kind, 'ACTIVO_FIJO');
});

test('2) rechaza categoría de activo fijo sin cuenta de activo', async () => {
  const { clinicId, userId, depAcc, accumAcc } = await setup();
  const r = await H.runController(inv.createCategory, H.mockReq(clinicId, userId, {
    code: 'AF-X', name: 'X', kind: 'ACTIVO_FIJO', depreciationAccount: String(depAcc._id), accumDepreciationAccount: String(accumAcc._id), usefulLifeMonths: 10, expenseType: 'OTRO',
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /cuenta de activo/i);
});

test('3) rechaza categoría depreciable sin cuenta de depreciación', async () => {
  const { clinicId, userId, assetAcc, accumAcc } = await setup();
  const r = await H.runController(inv.createCategory, H.mockReq(clinicId, userId, {
    code: 'AF-Y', name: 'Y', kind: 'ACTIVO_FIJO', assetAccount: String(assetAcc._id), accumDepreciationAccount: String(accumAcc._id), usefulLifeMonths: 10, expenseType: 'OTRO',
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /gasto de depreciación/i);
});

test('4) rechaza % residual mayor a 100', async () => {
  const { clinicId, userId, assetAcc, depAcc, accumAcc } = await setup();
  const r = await H.runController(inv.createCategory, H.mockReq(clinicId, userId, {
    code: 'AF-Z', name: 'Z', kind: 'ACTIVO_FIJO', assetAccount: String(assetAcc._id), depreciationAccount: String(depAcc._id), accumDepreciationAccount: String(accumAcc._id), usefulLifeMonths: 10, residualPercent: 150, expenseType: 'OTRO',
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /residual/i);
});

test('4b) rechaza cuenta de activo que no permite movimiento', async () => {
  const { clinicId, userId, noMov, depAcc, accumAcc } = await setup();
  const r = await H.runController(inv.createCategory, H.mockReq(clinicId, userId, {
    code: 'AF-NM', name: 'NM', kind: 'ACTIVO_FIJO', assetAccount: String(noMov._id), depreciationAccount: String(depAcc._id), accumDepreciationAccount: String(accumAcc._id), usefulLifeMonths: 10, expenseType: 'OTRO',
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /no permite movimiento/i);
});

// ── Compras con activo fijo ──────────────────────────────────────────────────
test('5) compra nueva de activo fijo con categoría válida crea asiento correcto', async () => {
  const { clinicId, userId, cat, assetAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(cat._id, 1000)] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, assetAcc.code), 1000, 'activo debitado desde la categoría');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -1000, 'CxP proveedor');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  const asset = await FixedAsset.findOne({ clinic: clinicId, purchaseInvoice: r.payload._id });
  assert.ok(asset);
  assert.ok(asset.journalEntry, 'el activo queda vinculado al asiento de compra');
  assert.equal(String(asset.journalEntry), String(r.payload.journalEntry), 'mismo asiento que la factura');
});

test('6) compra nueva de activo fijo con categoría incompleta falla', async () => {
  const { clinicId, userId, assetAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  // Categoría depreciable pero SIN cuentas de depreciación (insertada directo, saltando validación de UI).
  const bad = await InventoryCategory.create({ clinic: clinicId, code: 'AF-BAD', name: 'Bad', kind: 'ACTIVO_FIJO', assetAccount: assetAcc._id, usefulLifeMonths: 10, expenseType: 'OTRO' });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(bad._id, 1000)] }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /configuración contable completa/i);
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 0);
});

test('7) compra nueva de activo fijo NO acepta cuenta manual (usa la de la categoría)', async () => {
  const { clinicId, userId, cat, assetAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const otra = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.05.99', name: 'Otra cuenta', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [{ description: 'Laptop', lineType: 'ACTIVO_FIJO', quantity: 1, unitPrice: 1000, ivaRate: 0, subtotal: 1000, account: String(otra._id), fixedAsset: { category: cat._id, name: 'Laptop', assetAccount: String(otra._id), depreciationRate: 99, usefulLifeMonths: 3, residualPercent: 50 } }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, assetAcc.code), 1000, 'usa la cuenta de la categoría, no la manual');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.2.05.99'), 0, 'la cuenta manual NO se usa');
  const asset = await FixedAsset.findOne({ clinic: clinicId, purchaseInvoice: r.payload._id });
  assert.equal(String(asset.assetAccount), String(assetAcc._id));
  assert.equal(asset.depreciationRate, 120, 'tasa derivada de la categoría (1200/10), no la manual 99');
  assert.equal(asset.usefulLifeMonths, 10, 'vida útil de la categoría, no la manual 3');
  assert.equal(asset.residualPercent, 0, 'residual de la categoría, no el manual 50');
});

test('8) compra nueva de activo fijo NO acepta distribución de cuentas', async () => {
  const { clinicId, userId, cat } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [{ description: 'Laptop', lineType: 'ACTIVO_FIJO', quantity: 1, unitPrice: 1000, ivaRate: 0, subtotal: 1000, fixedAsset: { category: cat._id, name: 'Laptop' }, accountSplits: [{ account: String(cat.assetAccount), amount: 1000 }] }],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /distribución/i);
});

test('9) activo creado desde compra copia el snapshot de la categoría', async () => {
  const { clinicId, userId, cat, assetAcc, depAcc, accumAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(cat._id, 1000)] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const a = await FixedAsset.findOne({ clinic: clinicId, purchaseInvoice: r.payload._id });
  assert.equal(String(a.assetAccount), String(assetAcc._id));
  assert.equal(String(a.depreciationAccount), String(depAcc._id));
  assert.equal(String(a.accumDepreciationAccount), String(accumAcc._id));
  assert.equal(a.usefulLifeMonths, 10);
  assert.equal(a.residualPercent, 0);
  assert.equal(a.expenseType, 'ADMINISTRATIVO');
  assert.equal(a.monthlyDepreciation, 100); // 1000/10
});

test('10) cambiar la categoría después NO altera activos ya creados', async () => {
  const { clinicId, userId, cat, assetAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(cat._id, 1000)] }));
  const a1 = await FixedAsset.findOne({ clinic: clinicId, purchaseInvoice: r.payload._id });
  // Cambia la vida útil y % residual de la categoría.
  const otherAsset = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.05.77', name: 'Nueva cta activo', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const up = await H.runController(inv.updateCategory, H.mockReq(clinicId, userId, { usefulLifeMonths: 60, residualPercent: 25, assetAccount: String(otherAsset._id) }, { params: { id: String(cat._id) } }));
  assert.equal(up.statusCode, 200, JSON.stringify(up.payload));
  const a2 = await FixedAsset.findById(a1._id);
  assert.equal(a2.usefulLifeMonths, 10, 'el activo conserva su snapshot');
  assert.equal(a2.residualPercent, 0);
  assert.equal(String(a2.assetAccount), String(assetAcc._id));
});

// ── Depreciación ─────────────────────────────────────────────────────────────
test('11+13) depreciación usa el snapshot del activo y su asiento cuadra', async () => {
  const { clinicId, userId, cat, depAcc, accumAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(cat._id, 1000)] }));
  const r = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.totalDepreciation, 100, 'monto = snapshot mensual (1000/10)');
  assert.equal(await H.accountBalanceByCode(clinicId, depAcc.code), 100, 'gasto depreciación al debe');
  assert.equal(await H.accountBalanceByCode(clinicId, accumAcc.code), -100, 'dep. acumulada al haber');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  const entry = await JournalEntry.findOne({ clinic: clinicId, source: 'DEPRECIACION' });
  assert.ok(entry, 'existe asiento de depreciación');
  assert.equal(entry.sourceModel, 'FixedAsset');
});

test('12) la depreciación no baja del valor residual', async () => {
  const { clinicId, userId, cat } = await setup();
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(cat._id, 1000)] }));
  const a = await FixedAsset.findOne({ clinic: clinicId });
  // Simula que ya está casi totalmente depreciado (queda solo 30 por depreciar; residual 0).
  a.accumulatedDepreciation = 970; a.bookValue = 30; await a.save();
  const r = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.totalDepreciation, 30, 'solo deprecia el remanente, no el mensual completo');
  const after = await FixedAsset.findById(a._id);
  assert.equal(after.accumulatedDepreciation, 1000);
  assert.equal(after.bookValue, 0, 'no baja del residual (0)');
});

test('13b) no duplica la depreciación del mismo período (idempotente)', async () => {
  const { clinicId, userId, cat, depAcc, accumAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(cat._id, 1000)] }));
  const first = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M }));
  assert.equal(first.statusCode, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.totalDepreciation, 100);
  // Segunda corrida del MISMO período: no debe volver a depreciar.
  const second = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M }));
  assert.equal(second.statusCode, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.processed, 0, 'no procesa activos ya depreciados en el período');
  assert.equal(second.payload.totalDepreciation, 0);
  // El acumulado y el mayor NO se duplican.
  const a = await FixedAsset.findOne({ clinic: clinicId });
  assert.equal(a.accumulatedDepreciation, 100, 'acumulado no se duplica');
  assert.equal(await H.accountBalanceByCode(clinicId, depAcc.code), 100, 'gasto no se duplica');
  assert.equal(await H.accountBalanceByCode(clinicId, accumAcc.code), -100, 'dep. acumulada no se duplica');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'DEPRECIACION' }), 1, 'un solo asiento de depreciación');
});

// ── Creación / edición manual de activos ─────────────────────────────────────
test('createAsset manual copia snapshot de la categoría e ignora overrides', async () => {
  const { clinicId, userId, cat, assetAcc } = await setup();
  const r = await H.runController(inv.createAsset, H.mockReq(clinicId, userId, {
    code: 'AF-M1', name: 'PC oficina', category: String(cat._id), acquisitionCost: 800, acquisitionDate: H.docDate(),
    usefulLifeMonths: 999, residualPercent: 80, assetAccount: 'deadbeefdeadbeefdeadbeef', // overrides que deben ignorarse
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.usefulLifeMonths, 10, 'toma vida útil de la categoría');
  assert.equal(r.payload.residualPercent, 0);
  assert.equal(String(r.payload.assetAccount), String(assetAcc._id));
  assert.equal(r.payload.monthlyDepreciation, 80); // 800/10
});

test('createAsset manual sin categoría falla', async () => {
  const { clinicId, userId } = await setup();
  const r = await H.runController(inv.createAsset, H.mockReq(clinicId, userId, { code: 'AF-M2', name: 'X', acquisitionCost: 500 }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /categoría/i);
});

test('updateAsset NO altera cuentas ni parámetros contables (solo descriptivos)', async () => {
  const { clinicId, userId, cat, assetAcc } = await setup();
  const created = await H.runController(inv.createAsset, H.mockReq(clinicId, userId, { code: 'AF-M3', name: 'PC', category: String(cat._id), acquisitionCost: 1000, acquisitionDate: H.docDate() }));
  const id = created.payload._id;
  const r = await H.runController(inv.updateAsset, H.mockReq(clinicId, userId, {
    name: 'PC renombrada', serial: 'SN-123',
    usefulLifeMonths: 999, residualPercent: 90, assetAccount: 'deadbeefdeadbeefdeadbeef', depreciationRate: 99,
  }, { params: { id: String(id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.name, 'PC renombrada');
  assert.equal(r.payload.serial, 'SN-123');
  assert.equal(r.payload.usefulLifeMonths, 10, 'no cambia la vida útil (snapshot)');
  assert.equal(String(r.payload.assetAccount), String(assetAcc._id), 'no cambia la cuenta');
  assert.equal(r.payload.depreciationRate, 120, 'no cambia la tasa');
});

// ── Legacy ──────────────────────────────────────────────────────────────────
test('14) activos legacy (con cuentas propias) siguen depreciando', async () => {
  const { clinicId, userId, depAcc, accumAcc, assetAcc } = await setup();
  // Activo legacy insertado directo con SUS PROPIAS cuentas y parámetros (sin categoría completa).
  await FixedAsset.create({
    clinic: clinicId, code: 'AF-LEG', name: 'Equipo viejo',
    assetAccount: assetAcc._id, depreciationAccount: depAcc._id, accumDepreciationAccount: accumAcc._id,
    acquisitionDate: H.docDate(), startDate: H.docDate(), acquisitionCost: 1200,
    residualValue: 0, residualPercent: 0, depreciationRate: 10, usefulLifeMonths: 12, monthlyDepreciation: 100, bookValue: 1200, status: 'ACTIVO',
  });
  const r = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.totalDepreciation, 100);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('meses pendientes se contabilizan una vez por período y la repetición no duplica el mayor', async () => {
  const { clinicId, userId, depAcc, accumAcc, assetAcc } = await setup();
  const start = new Date(Y, M - 3, 1); // dos meses anteriores y el actual
  const asset = await FixedAsset.create({
    clinic: clinicId, code: 'AF-PEND', name: 'Equipo pendiente',
    assetAccount: assetAcc._id, depreciationAccount: depAcc._id,
    accumDepreciationAccount: accumAcc._id, acquisitionDate: start, startDate: start,
    acquisitionCost: 1200, residualValue: 0, depreciationRate: 10,
    usefulLifeMonths: 12, monthlyDepreciation: 100, bookValue: 1200,
  });
  const single = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M }));
  assert.equal(single.statusCode, 409, JSON.stringify(single.payload));
  const preview = await H.runController(inv.previewDepreciation, H.mockReq(clinicId, userId, {}, { query: { year: Y, month: M, catchUp: 'true' } }));
  assert.equal(preview.statusCode, 200, JSON.stringify(preview.payload));
  assert.equal(preview.payload.periods.length, 3);
  assert.equal(preview.payload.total, 300);
  const first = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M, catchUp: true }));
  assert.equal(first.statusCode, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.periods.length, 3);
  assert.equal(first.payload.totalDepreciation, 300);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'DEPRECIACION' }), 3);
  const again = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M, catchUp: true }));
  assert.equal(again.statusCode, 200, JSON.stringify(again.payload));
  assert.equal(again.payload.totalDepreciation, 0);
  assert.equal((await FixedAsset.findById(asset._id)).history.length, 3);
  assert.equal(await H.accountBalanceByCode(clinicId, depAcc.code), 300);
  assert.equal(await H.accountBalanceByCode(clinicId, accumAcc.code), -300);
  const emptyPreview = await H.runController(inv.previewDepreciation, H.mockReq(clinicId, userId, {}, { query: { year: Y, month: M } }));
  assert.equal(emptyPreview.statusCode, 200, JSON.stringify(emptyPreview.payload));
  assert.equal(emptyPreview.payload.total, 0);
});

test('cerrar el mes anterior deprecia activos y cierra el período en la misma operación', async () => {
  const { clinicId, userId, depAcc, accumAcc, assetAcc } = await setup();
  const previous = new Date(Y, M - 2, 1);
  const period = await getOrCreatePeriod(clinicId, previous);
  const asset = await FixedAsset.create({ clinic: clinicId, code: 'AF-CIERRE', name: 'Equipo',
    assetAccount: assetAcc._id, depreciationAccount: depAcc._id, accumDepreciationAccount: accumAcc._id,
    acquisitionDate: previous, startDate: previous, acquisitionCost: 1200,
    residualValue: 0, depreciationRate: 10, usefulLifeMonths: 12,
    monthlyDepreciation: 100, bookValue: 1200 });
  const closed = await H.runController(fiscal.close, H.mockReq(clinicId, userId,
    {}, { params: { id: String(period._id) } }));
  assert.equal(closed.statusCode, 200, JSON.stringify(closed.payload));
  assert.equal(closed.payload.depreciation.totalDepreciation, 100);
  assert.equal((await FixedAsset.findById(asset._id)).accumulatedDepreciation, 100);
  assert.equal((await FiscalPeriod.findById(period._id)).status, 'CERRADO');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'DEPRECIACION' }), 1);
});

test('si falta una cuenta de depreciación el mes permanece abierto y no se crea asiento', async () => {
  const { clinicId, userId, accumAcc, assetAcc } = await setup();
  const previous = new Date(Y, M - 2, 1);
  const period = await getOrCreatePeriod(clinicId, previous);
  const asset = await FixedAsset.create({ clinic: clinicId, code: 'AF-INCOMPLETO', name: 'Equipo',
    assetAccount: assetAcc._id, accumDepreciationAccount: accumAcc._id,
    acquisitionDate: previous, startDate: previous, acquisitionCost: 1200,
    residualValue: 0, depreciationRate: 10, usefulLifeMonths: 12,
    monthlyDepreciation: 100, bookValue: 1200 });
  const blocked = await H.runController(fiscal.close, H.mockReq(clinicId, userId,
    {}, { params: { id: String(period._id) } }));
  assert.equal(blocked.statusCode, 400, JSON.stringify(blocked.payload));
  assert.equal((await FiscalPeriod.findById(period._id)).status, 'ABIERTO');
  assert.equal((await FixedAsset.findById(asset._id)).history.length, 0);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'DEPRECIACION' }), 0);
});

test('el cierre anual incorpora la depreciación pendiente antes del resultado', async () => {
  const { clinicId, userId, depAcc, accumAcc, assetAcc } = await setup();
  const year = Y - 1;
  const december = new Date(year, 11, 1);
  await FixedAsset.create({ clinic: clinicId, code: 'AF-ANUAL', name: 'Equipo',
    assetAccount: assetAcc._id, depreciationAccount: depAcc._id, accumDepreciationAccount: accumAcc._id,
    acquisitionDate: december, startDate: december, acquisitionCost: 1200,
    residualValue: 0, depreciationRate: 10, usefulLifeMonths: 12,
    monthlyDepreciation: 100, bookValue: 1200 });
  const closed = await H.runController(fiscal.closeYear, H.mockReq(clinicId, userId, { year }));
  assert.equal(closed.statusCode, 200, JSON.stringify(closed.payload));
  assert.equal(closed.payload.utilidad, -100);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'DEPRECIACION' }), 1);
  assert.equal((await FiscalPeriod.findOne({ clinic: clinicId, year, month: 12 })).status, 'CERRADO');
});
