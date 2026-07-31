/**
 * Compras mixtas (GASTO + INVENTARIO + ACTIVO_FIJO en una misma factura) y reglas
 * de clasificación por línea:
 *   - contabiliza cada tipo con su cuenta (gasto manual / inventario de categoría /
 *     activo fijo de categoría) sin pedir cuenta manual a inventario/activo;
 *   - la cuenta por defecto del proveedor SOLO se aplica a líneas GASTO;
 *   - importación (TXT/XML) no contamina con la cuenta de gasto del proveedor;
 *   - edición de una compra "antigua" (sin lineType) sigue funcionando.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const FixedAsset = require('../models/FixedAsset');
const Product = require('../models/Product');
const RecurringAccount = require('../models/RecurringAccount');
const Supplier = require('../models/Supplier');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// Los importadores rechazan comprobantes con fecha anterior a hoy
// (utils/fiscalDocumentDate), así que los ficheros de prueba se fechan HOY.
const FECHA_HOY = (() => {
  const d = H.docDate();
  const p2 = (x) => String(x).padStart(2, '0');
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()}`;
})();

async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const assetAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.05.99', name: 'Equipos (test)', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const depAcc = await ChartOfAccount.create({ clinic: clinicId, code: '5.2.99', name: 'Gasto depreciación (test)', type: 'GASTO', nature: 'DEBITO', allowsMovement: true });
  const accumAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.99.01', name: 'Dep. acumulada (test)', type: 'ACTIVO', nature: 'CREDITO', allowsMovement: true });
  const afCat = await InventoryCategory.create({ clinic: clinicId, code: 'AF-TST', name: 'Equipos médicos', kind: 'ACTIVO_FIJO', assetAccount: assetAcc._id, depreciationAccount: depAcc._id, accumDepreciationAccount: accumAcc._id, depreciationRate: 10, usefulLifeYears: 10, residualPercent: 0, expenseType: 'ADMINISTRATIVO' });
  // Categoría de INVENTARIO completa (activo + costo + ingreso): al contabilizar se
  // exigen las tres cuentas; la cuenta de inventario sale de aquí (sin fallback genérico).
  const invAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.04.01' });
  const costAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '5.1.01' });
  const incAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '4.1.02' });
  const invCat = await InventoryCategory.create({ clinic: clinicId, code: 'INV-TST', name: 'Insumos médicos', kind: 'INVENTARIO', assetAccount: invAcc._id, expenseAccount: costAcc._id, incomeAccount: incAcc._id });
  return { clinicId, userId, gasto, assetAcc, afCat, invAcc, invCat };
}
// Producto de inventario CON categoría contable configurada (caso normal).
const makeInvProduct = (clinicId, invCat, overrides = {}) =>
  H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id, ...overrides });
const gastoLine = (acc, val = 100) => ({ description: 'Transporte', lineType: 'GASTO', quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val, account: acc });
const invLine = (product, qty = 10, price = 5) => ({ description: 'Insumo', lineType: 'INVENTARIO', product, quantity: qty, unitPrice: price, ivaRate: 0, subtotal: qty * price });
const afLine = (catId, val = 1000) => ({ description: 'Ecógrafo', lineType: 'ACTIVO_FIJO', quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val, fixedAsset: { category: catId, name: 'Ecógrafo' } });

// ─────────────────────────────────────────────────────────────────────────────
test('compra solo gasto: contabiliza y cuadra', async () => {
  const { clinicId, userId, gasto } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [gastoLine(gasto._id, 100)] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.99'), 100);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -100);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('compra solo inventario: usa cuenta de inventario (sin cuenta manual) y sube stock', async () => {
  const { clinicId, userId, invCat } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await makeInvProduct(clinicId, invCat);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [invLine(prod._id, 10, 5)] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 50, 'inventario debitado');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -50);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  const p = await Product.findById(prod._id);
  assert.equal(p.stock, 10);
});

// ─────────────────────────────────────────────────────────────────────────────
test('compra solo activo fijo: usa cuenta de la categoría y crea el activo', async () => {
  const { clinicId, userId, afCat, assetAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(afCat._id, 1000)] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, assetAcc.code), 1000, 'activo fijo debitado desde la categoría');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -1000);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  const asset = await FixedAsset.findOne({ clinic: clinicId, purchaseInvoice: r.payload._id });
  assert.ok(asset, 'debe crearse el activo fijo');
  assert.equal(asset.acquisitionCost, 1000);
});

// ─────────────────────────────────────────────────────────────────────────────
test('compra MIXTA: gasto + inventario + activo fijo cuadra y los totales son correctos', async () => {
  const { clinicId, userId, gasto, afCat, assetAcc, invCat } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await makeInvProduct(clinicId, invCat);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [gastoLine(gasto._id, 100), invLine(prod._id, 10, 5), afLine(afCat._id, 1000)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.subtotal, 1150);
  assert.equal(inv.total, 1150);
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.99'), 100);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 50);
  assert.equal(await H.accountBalanceByCode(clinicId, assetAcc.code), 1000);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -1150);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  assert.equal((await Product.findById(prod._id)).stock, 10);
  assert.ok(await FixedAsset.findOne({ clinic: clinicId, purchaseInvoice: inv._id }));
});

// ─────────────────────────────────────────────────────────────────────────────
test('cuenta recurrente del proveedor SOLO se aplica a gasto (no a inventario ni activo)', async () => {
  const { clinicId, userId, gasto, afCat, assetAcc, invCat } = await setup();
  const sup = await Supplier.create({ clinic: clinicId, ruc: '0990004196001', razonSocial: 'Prov', defaultExpenseAccount: gasto._id });
  const prod = await makeInvProduct(clinicId, invCat);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [
      { description: 'Transporte', lineType: 'GASTO', quantity: 1, unitPrice: 100, ivaRate: 0, subtotal: 100 }, // sin cuenta → toma la del proveedor
      invLine(prod._id, 10, 5),
      afLine(afCat._id, 1000),
    ],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  const gastoIt = inv.items.find((i) => i.lineType === 'GASTO');
  const invIt = inv.items.find((i) => i.lineType === 'INVENTARIO');
  const afIt = inv.items.find((i) => i.lineType === 'ACTIVO_FIJO');
  assert.equal(String(gastoIt.account), String(gasto._id), 'gasto recibe la cuenta por defecto del proveedor');
  assert.notEqual(String(invIt.account), String(gasto._id), 'inventario NO usa la cuenta del proveedor');
  assert.notEqual(String(afIt.account), String(gasto._id), 'activo fijo NO usa la cuenta del proveedor');
  // Solo se memoriza la cuenta de gasto como recurrente (2: clínica + proveedor).
  assert.equal(await RecurringAccount.countDocuments({ clinic: clinicId, account: gasto._id }), 2);
  assert.equal(await RecurringAccount.countDocuments({ clinic: clinicId, account: invIt.account }), 0, 'inventario no se memoriza');
  assert.equal(await RecurringAccount.countDocuments({ clinic: clinicId, account: assetAcc._id }), 0, 'activo no se memoriza');
});

// ─────────────────────────────────────────────────────────────────────────────
test('importación TXT no aplica la cuenta de gasto del proveedor (queda por clasificar)', async () => {
  const { clinicId, userId, gasto } = await setup();
  // Proveedor con cuenta por defecto YA configurada; el import NO debe usarla.
  await Supplier.create({ clinic: clinicId, ruc: '0990004196001', razonSocial: 'CORP', defaultExpenseAccount: gasto._id });
  const TXT = [
    'RUC_EMISOR\tRAZON_SOCIAL_EMISOR\tTIPO_COMPROBANTE\tSERIE_COMPROBANTE\tCLAVE_ACCESO\tFECHA_AUTORIZACION\tFECHA_EMISION\tIDENTIFICACION_RECEPTOR\tVALOR_SIN_IMPUESTOS\tIVA\tIMPORTE_TOTAL\tNUMERO_DOCUMENTO_MODIFICADO',
    `0990004196001\tCORP\tFactura\t002-201-000118601\t0106202601099000419600120022010001186010011860110\t${FECHA_HOY} 10:03:32\t${FECHA_HOY}\t0993404160001\t100\t15\t115\t`,
  ].join('\n');
  const imp = await H.runController(purchase.importTxt, H.mockReq(clinicId, userId, { content: TXT }));
  assert.equal(imp.statusCode, 200);
  assert.equal(imp.payload.created, 1);
  const inv = await PurchaseInvoice.findOne({ clinic: clinicId });
  assert.equal(inv.status, 'POR_AUTORIZAR');
  assert.equal(inv.items[0].account, null, 'la línea importada no debe traer la cuenta de gasto del proveedor');
});

// ─────────────────────────────────────────────────────────────────────────────
test('importación XML deja la factura POR_AUTORIZAR sin cuenta asignada', async () => {
  const { clinicId, userId, gasto } = await setup();
  await Supplier.create({ clinic: clinicId, ruc: '1790283380001', razonSocial: 'DINERS', defaultExpenseAccount: gasto._id });
  const XML = `<?xml version="1.0" encoding="UTF-8"?><factura><infoTributaria><ruc>1790283380001</ruc><razonSocial>DINERS</razonSocial><estab>001</estab><ptoEmi>014</ptoEmi><secuencial>000000123</secuencial><claveAcceso>XYZ123</claveAcceso></infoTributaria><infoFactura><fechaEmision>${FECHA_HOY}</fechaEmision><totalSinImpuestos>50.00</totalSinImpuestos><importeTotal>50.00</importeTotal></infoFactura><detalles><detalle><descripcion>Servicio</descripcion><cantidad>1</cantidad><precioUnitario>50</precioUnitario><descuento>0</descuento><precioTotalSinImpuesto>50</precioTotalSinImpuesto></detalle></detalles></factura>`;
  const imp = await H.runController(purchase.importXml, H.mockReq(clinicId, userId, { xmls: [XML] }));
  assert.equal(imp.statusCode, 200, JSON.stringify(imp.payload));
  assert.equal(imp.payload.created, 1, JSON.stringify(imp.payload));
  const inv = await PurchaseInvoice.findOne({ clinic: clinicId, importedFromXml: true });
  assert.ok(inv);
  assert.equal(inv.status, 'POR_AUTORIZAR');
  assert.equal(inv.items[0].account, null, 'sin cuenta de gasto por defecto');
});

// ─────────────────────────────────────────────────────────────────────────────
test('edición de compra ANTIGUA (item con producto sin lineType) sigue funcionando', async () => {
  const { clinicId, userId } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0 });
  // Inserta una factura "antigua": item con producto pero SIN lineType, ya REGISTRADA, sin asiento.
  const legacy = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: H.docDate(), serie: '001-001-000000999',
    items: [{ description: 'Insumo viejo', product: prod._id, quantity: 5, unitPrice: 4, subtotal: 20, ivaRate: 0 }],
    subtotal: 20, total: 20, balance: 20, status: 'REGISTRADA',
  });
  // Editar: cambiar cantidad. classify infiere INVENTARIO por el producto y no exige cuenta.
  const upd = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    fechaEmision: H.docDate(),
    items: [{ description: 'Insumo viejo', product: prod._id, quantity: 8, unitPrice: 4, subtotal: 32, ivaRate: 0 }],
  }, { params: { id: String(legacy._id) } }));
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.payload));
  const inv = await PurchaseInvoice.findById(legacy._id);
  assert.equal(inv.items[0].lineType, 'INVENTARIO', 'se reclasifica por el producto');
  assert.equal(inv.subtotal, 32);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  assert.equal((await Product.findById(prod._id)).stock, 8);
});

// ── Resolución ESTRICTA de cuentas en compras NUEVAS (sin fallback silencioso) ──
test('compra NUEVA de inventario con categoría SIN cuenta de inventario debe fallar', async () => {
  const { clinicId, userId } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const catNoAcc = await InventoryCategory.create({ clinic: clinicId, code: 'INV-SINCTA', name: 'Sin cuenta', kind: 'INVENTARIO' });
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: catNoAcc._id });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [invLine(prod._id, 10, 5)] }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /cuenta de inventario/i);
  // No debe haber contabilizado ni movido stock.
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 0);
  assert.equal((await Product.findById(prod._id)).stock, 0);
});

test('compra NUEVA de inventario cuyo producto NO tiene categoría debe fallar', async () => {
  const { clinicId, userId } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: null }); // sin inventoryCategory
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [invLine(prod._id, 10, 5)] }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /categoría contable/i);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 0);
});

test('compra NUEVA de activo fijo con categoría SIN cuenta de activo debe fallar', async () => {
  const { clinicId, userId } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const afNoAcc = await InventoryCategory.create({ clinic: clinicId, code: 'AF-SINCTA', name: 'AF sin cuenta', kind: 'ACTIVO_FIJO' });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(afNoAcc._id, 1000)] }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /cuenta de activo/i);
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 0, 'no debe crear el activo');
});

test('compra NUEVA de activo fijo SIN categoría debe fallar', async () => {
  const { clinicId, userId } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const item = { description: 'Ecógrafo', lineType: 'ACTIVO_FIJO', quantity: 1, unitPrice: 1000, ivaRate: 0, subtotal: 1000, fixedAsset: { name: 'Ecógrafo' } };
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [item] }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /categoría de activo fijo/i);
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 0);
});

test('gasto con product colgado pero lineType GASTO NO se convierte en inventario', async () => {
  const { clinicId, userId, gasto, invCat } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await makeInvProduct(clinicId, invCat, { stock: 3 });
  // Línea marcada explícitamente GASTO pero arrastrando un product: debe respetarse GASTO.
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [{ description: 'Servicio con product colgado', lineType: 'GASTO', quantity: 1, unitPrice: 100, ivaRate: 0, subtotal: 100, account: gasto._id, product: prod._id }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const inv = await PurchaseInvoice.findById(r.payload._id);
  assert.equal(inv.items[0].lineType, 'GASTO', 'la línea sigue siendo GASTO');
  assert.equal(inv.items[0].product, null, 'se limpia el producto colgado');
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.99'), 100, 'debita al gasto');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 0, 'NO debita inventario');
  assert.equal((await Product.findById(prod._id)).stock, 3, 'NO mueve stock');
});

test('editar una compra LEGACY con producto SIN categoría ahora se BLOQUEA (estricto único, sin ruta tolerante)', async () => {
  const { clinicId, userId } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const legacyAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.04.02' }); // cuenta de inventario legacy
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: null }); // sin categoría (legacy)
  // Factura antigua ya REGISTRADA (strictAccounts=false), con la cuenta legacy en la línea.
  const legacy = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: H.docDate(), serie: '001-001-000000777',
    strictAccounts: false,
    items: [{ description: 'Insumo legacy', product: prod._id, account: legacyAcc._id, quantity: 5, unitPrice: 4, subtotal: 20, ivaRate: 0 }],
    subtotal: 20, total: 20, balance: 20, status: 'REGISTRADA',
  });
  // Editar ahora exige categoría (Tarea 1.2): sin ella, bloquea con un mensaje que guía a configurarla.
  const upd = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    fechaEmision: H.docDate(),
    items: [{ description: 'Insumo legacy', lineType: 'INVENTARIO', product: prod._id, quantity: 5, unitPrice: 4, subtotal: 20, ivaRate: 0 }],
  }, { params: { id: String(legacy._id) } }));
  assert.equal(upd.statusCode, 400, JSON.stringify(upd.payload));
  assert.match(upd.payload.message, /categoría contable/i);
  // No recontabilizó nada nuevo.
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.02'), 0, 'no contabiliza a la cuenta legacy');
});

// ── update ESTRICTO para compras del flujo nuevo (sin tolerancia legacy) ────────
test('editar compra NUEVA de inventario tras perder la cuenta de la categoría debe fallar (no cae al genérico)', async () => {
  const { clinicId, userId, invCat } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await makeInvProduct(clinicId, invCat);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [invLine(prod._id, 10, 5)] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal((await PurchaseInvoice.findById(r.payload._id)).strictAccounts, true, 'la compra nueva nace estricta');
  // La categoría pierde su cuenta de inventario.
  await InventoryCategory.updateOne({ _id: invCat._id }, { $unset: { assetAccount: 1 } });
  const upd = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    fechaEmision: H.docDate(),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 12, unitPrice: 5, ivaRate: 0, subtotal: 60 }],
  }, { params: { id: String(r.payload._id) } }));
  assert.equal(upd.statusCode, 400, JSON.stringify(upd.payload));
  assert.match(upd.payload.message, /cuenta de inventario/i);
});

test('editar compra NUEVA de activo fijo tras perder la cuenta de la categoría debe fallar', async () => {
  const { clinicId, userId, afCat } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [afLine(afCat._id, 1000)] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  await InventoryCategory.updateOne({ _id: afCat._id }, { $unset: { assetAccount: 1 } });
  const upd = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    fechaEmision: H.docDate(),
    items: [afLine(afCat._id, 1200)],
  }, { params: { id: String(r.payload._id) } }));
  assert.equal(upd.statusCode, 400, JSON.stringify(upd.payload));
  assert.match(upd.payload.message, /cuenta de activo/i);
});

test('editar compra NUEVA de inventario con categoría válida sigue funcionando (estricto sin romper)', async () => {
  const { clinicId, userId, invCat } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await makeInvProduct(clinicId, invCat);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: H.docDate(), items: [invLine(prod._id, 10, 5)] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const upd = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    fechaEmision: H.docDate(),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 12, unitPrice: 5, ivaRate: 0, subtotal: 60 }],
  }, { params: { id: String(r.payload._id) } }));
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 60);
  assert.equal((await Product.findById(prod._id)).stock, 12);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  assert.equal((await PurchaseInvoice.findById(r.payload._id)).strictAccounts, true, 'conserva la marca estricta');
});

test('authorize sigue siendo ESTRICTO: inventario sin categoría no se puede autorizar', async () => {
  const { clinicId, userId } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: null });
  // Factura POR_AUTORIZAR con una línea de inventario cuyo producto no tiene categoría.
  const inv = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: H.docDate(), serie: '001-001-000000555',
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 10, unitPrice: 5, subtotal: 50, ivaRate: 0 }],
    subtotal: 50, total: 50, balance: 50, status: 'POR_AUTORIZAR',
  });
  const r = await H.runController(purchase.authorize, H.mockReq(clinicId, userId, {}, { params: { id: String(inv._id) } }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /categoría contable/i);
  assert.equal((await PurchaseInvoice.findById(inv._id)).status, 'POR_AUTORIZAR', 'sigue pendiente (no se contabilizó)');
});
