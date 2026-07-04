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

async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const assetAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.05.99', name: 'Equipos (test)', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const afCat = await InventoryCategory.create({ clinic: clinicId, code: 'AF-TST', name: 'Equipos médicos', kind: 'ACTIVO_FIJO', assetAccount: assetAcc._id, depreciationRate: 10, usefulLifeYears: 10 });
  return { clinicId, userId, gasto, assetAcc, afCat };
}
const gastoLine = (acc, val = 100) => ({ description: 'Transporte', lineType: 'GASTO', quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val, account: acc });
const invLine = (product, qty = 10, price = 5) => ({ description: 'Insumo', lineType: 'INVENTARIO', product, quantity: qty, unitPrice: price, ivaRate: 0, subtotal: qty * price });
const afLine = (catId, val = 1000) => ({ description: 'Ecógrafo', lineType: 'ACTIVO_FIJO', quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val, fixedAsset: { category: catId, name: 'Ecógrafo' } });

// ─────────────────────────────────────────────────────────────────────────────
test('compra solo gasto: contabiliza y cuadra', async () => {
  const { clinicId, userId, gasto } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: new Date('2026-06-05'), items: [gastoLine(gasto._id, 100)] }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, '6.1.99'), 100);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -100);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('compra solo inventario: usa cuenta de inventario (sin cuenta manual) y sube stock', async () => {
  const { clinicId, userId } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0 });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: new Date('2026-06-05'), items: [invLine(prod._id, 10, 5)] }));
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
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: new Date('2026-06-05'), items: [afLine(afCat._id, 1000)] }));
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
  const { clinicId, userId, gasto, afCat, assetAcc } = await setup();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0 });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
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
  const { clinicId, userId, gasto, afCat, assetAcc } = await setup();
  const sup = await Supplier.create({ clinic: clinicId, ruc: '0990004196001', razonSocial: 'Prov', defaultExpenseAccount: gasto._id });
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0 });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
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
    '0990004196001\tCORP\tFactura\t002-201-000118601\t0106202601099000419600120022010001186010011860110\t01/06/2026 10:03:32\t01/06/2026\t0993404160001\t100\t15\t115\t',
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
  const XML = `<?xml version="1.0" encoding="UTF-8"?><factura><infoTributaria><ruc>1790283380001</ruc><razonSocial>DINERS</razonSocial><estab>001</estab><ptoEmi>014</ptoEmi><secuencial>000000123</secuencial><claveAcceso>XYZ123</claveAcceso></infoTributaria><infoFactura><fechaEmision>05/06/2026</fechaEmision><totalSinImpuestos>50.00</totalSinImpuestos><importeTotal>50.00</importeTotal></infoFactura><detalles><detalle><descripcion>Servicio</descripcion><cantidad>1</cantidad><precioUnitario>50</precioUnitario><descuento>0</descuento><precioTotalSinImpuesto>50</precioTotalSinImpuesto></detalle></detalles></factura>`;
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
    clinic: clinicId, supplier: sup._id, fechaEmision: new Date('2026-06-05'), serie: '001-001-000000999',
    items: [{ description: 'Insumo viejo', product: prod._id, quantity: 5, unitPrice: 4, subtotal: 20, ivaRate: 0 }],
    subtotal: 20, total: 20, balance: 20, status: 'REGISTRADA',
  });
  // Editar: cambiar cantidad. classify infiere INVENTARIO por el producto y no exige cuenta.
  const upd = await H.runController(purchase.update, H.mockReq(clinicId, userId, {
    fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Insumo viejo', product: prod._id, quantity: 8, unitPrice: 4, subtotal: 32, ivaRate: 0 }],
  }, { params: { id: String(legacy._id) } }));
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.payload));
  const inv = await PurchaseInvoice.findById(legacy._id);
  assert.equal(inv.items[0].lineType, 'INVENTARIO', 'se reclasifica por el producto');
  assert.equal(inv.subtotal, 32);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  assert.equal((await Product.findById(prod._id)).stock, 8);
});
