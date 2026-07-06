/**
 * Auditoría global de integración contable (docs/accounting-integration-audit.md).
 *
 * Codifica los invariantes transversales verificados en la auditoría y las tres
 * correcciones aplicadas:
 *   K1 — baja de activo (disposeAsset) resuelve cuentas por ROL (no código fijo).
 *   K2 — cobro de una venta (Sale) por el flujo de Payment (enum docModel incluye Sale).
 *   K3 — pago/cobro por banco sin cuenta contable se bloquea con mensaje claro.
 *
 * Mapa de flujos del pedido (J):
 *   J1/J7 compra inventario con retención → asiento, CxP neto, kardex, 103  ......  T1
 *   J8/J9 depreciación idempotente por período (no duplica)  .....................  T2
 *   J2    activo fijo: baja usa cuentas por rol y cuadra  ........................  T3
 *   J5    cobro de venta (Sale) por Payment: CxC baja, asiento  ..................  T4
 *   guardas de configuración (banco sin cuenta contable)  .......................  T5
 *   trazabilidad: todo asiento automático tiene source/sourceModel/sourceRef  ....  T6
 *   guarda anti-duplicado: período cerrado bloquea la contabilización  ...........  T7
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const inv = require('../controllers/inventoryAdvancedController');
const sales = require('../controllers/saleController');
const payments = require('../controllers/paymentController');
const reports = require('../controllers/accountingReportsController');

const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const InventoryLayer = require('../models/InventoryLayer');
const RetentionRule = require('../models/RetentionRule');
const AccountingConfig = require('../models/AccountingConfig');
const FiscalPeriod = require('../models/FiscalPeriod');
const FixedAsset = require('../models/FixedAsset');
const Payment = require('../models/Payment');
const Payable = require('../models/Payable');
const Receivable = require('../models/Receivable');
const Sale = require('../models/Sale');
const JournalEntry = require('../models/JournalEntry');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Clínica + categoría de inventario con cuenta + reglas de retención RENTA/IVA. */
async function setupPurchases() {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const invAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.04.01' });
  const invCat = await InventoryCategory.create({ clinic: clinicId, code: 'INV', name: 'Insumos', kind: 'INVENTARIO', assetAccount: invAcc._id });
  const ruleRenta = await RetentionRule.create({ clinic: clinicId, type: 'RENTA', code: '312', description: 'Bienes', rate: 2, appliesTo: 'BIENES', baseType: 'SUBTOTAL_TOTAL' });
  const ruleIva = await RetentionRule.create({ clinic: clinicId, type: 'IVA', code: '721', description: 'IVA 30%', rate: 30, appliesTo: 'BIENES', baseType: 'IVA' });
  return { clinicId, userId, invCat, ruleRenta, ruleIva };
}

/** Categoría de activo fijo completa (vida útil 10 → dep mensual = costo/10). */
async function setupAssetCategory(clinicId) {
  const assetAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.05.10', name: 'Equipos', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const depAcc = await ChartOfAccount.create({ clinic: clinicId, code: '5.2.10', name: 'Gasto depreciación', type: 'GASTO', nature: 'DEBITO', allowsMovement: true });
  const accumAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.90.10', name: 'Dep. acumulada', type: 'ACTIVO', nature: 'CREDITO', allowsMovement: true });
  const cat = await InventoryCategory.create({
    clinic: clinicId, code: 'AF-PC', name: 'Equipos', kind: 'ACTIVO_FIJO',
    assetAccount: assetAcc._id, depreciationAccount: depAcc._id, accumDepreciationAccount: accumAcc._id,
    usefulLifeMonths: 10, residualPercent: 0, expenseType: 'ADMINISTRATIVO',
  });
  return { assetAcc, depAcc, accumAcc, cat };
}

const afLine = (catId, val = 1000) => ({ description: 'Laptop', lineType: 'ACTIVO_FIJO', quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val, fixedAsset: { category: catId, name: 'Laptop' } });

// ─────────────────────────────────────────────────────────────────────────────
// T1 — Compra de inventario con RENTA+IVA: asiento cuadra, CxP neto, kardex y 103.
test('T1) compra inventario con retención: asiento/CxP/kardex/103 integrados', async () => {
  const { clinicId, userId, invCat, ruleRenta, ruleIva } = await setupPurchases();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  // Inventario 100 + IVA 15. Renta 2% de 100 = 2; IVA 30% de 15 = 4.5. CxP = 108.5.
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 10, unitPrice: 10, ivaRate: 15, subtotal: 100,
      retentions: [{ rule: String(ruleRenta._id) }, { rule: String(ruleIva._id) }] }],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  // Asiento: inventario al debe, CxP neto y retenciones al haber, cuadrado.
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 100, 'inventario debitado');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.02.04'), -2, 'ret. renta por pagar');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.02.03'), -4.5, 'ret. IVA por pagar');
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), -108.5, 'CxP neto');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);

  // CxP (subledger) por el neto.
  const pay = await Payable.findOne({ clinic: clinicId, sourceModel: 'PurchaseInvoice', sourceRef: r.payload._id });
  assert.ok(pay && pay.balance === 108.5, 'Payable por el neto');

  // Kardex: la compra creó una capa valorada.
  const layers = await InventoryLayer.find({ clinic: clinicId, product: prod._id });
  assert.equal(layers.length, 1, 'capa de kardex creada');
  assert.equal(layers[0].qtyRemaining, 10);
  assert.equal(layers[0].unitCost, 10);

  // Formulario 103 (RENTA) toma la retención.
  const f103 = await H.runController(reports.form103, H.mockReq(clinicId, userId, {}, { query: { year: '2026', month: '6' } }));
  assert.equal(f103.statusCode, 200, JSON.stringify(f103.payload));
  const row = f103.payload.rows.find((x) => x.code === '312');
  assert.ok(row && row.amount === 2, 'el 103 refleja la retención renta');
});

// ─────────────────────────────────────────────────────────────────────────────
// T2 — Depreciación idempotente: correr dos veces el mismo período no duplica.
test('T2) depreciación idempotente por período (no duplica asiento ni monto)', async () => {
  const { clinicId, userId } = await setupPurchases();
  const { cat, depAcc } = await setupAssetCategory(clinicId);
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: new Date('2026-06-05'), items: [afLine(cat._id, 1000)] }));

  const first = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: 2026, month: 6 }));
  assert.equal(first.statusCode, 200, JSON.stringify(first.payload));
  assert.equal(first.payload.totalDepreciation, 100, 'primer mes: 1000/10');

  const second = await H.runController(inv.runDepreciation, H.mockReq(clinicId, userId, { year: 2026, month: 6 }));
  assert.equal(second.statusCode, 200, JSON.stringify(second.payload));
  assert.equal(second.payload.processed, 0, 'segunda corrida no procesa nada');
  assert.equal(second.payload.totalDepreciation, 0);

  const depEntries = await JournalEntry.countDocuments({ clinic: clinicId, source: 'DEPRECIACION' });
  assert.equal(depEntries, 1, 'un solo asiento de depreciación para el período');
  assert.equal(await H.accountBalanceByCode(clinicId, depAcc.code), 100, 'gasto de depreciación no se duplicó');
  const asset = await FixedAsset.findOne({ clinic: clinicId });
  assert.equal(asset.accumulatedDepreciation, 100);
});

// ─────────────────────────────────────────────────────────────────────────────
// T3 (K1) — Baja de activo resuelve cuentas por ROL: la ganancia va a la cuenta
// REMAPEADA en AccountingConfig, no al código fijo 4.2.02.
test('T3) baja de activo usa cuentas por rol (remapeo de AccountingConfig)', async () => {
  const { clinicId, userId } = await setupPurchases();
  const { cat, assetAcc } = await setupAssetCategory(clinicId);
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, { supplier: sup._id, fechaEmision: new Date('2026-06-05'), items: [afLine(cat._id, 1000)] }));
  const asset = await FixedAsset.findOne({ clinic: clinicId });

  // El contador remapea el rol otrosIngresos a una cuenta propia.
  const otrosIngresosCustom = await ChartOfAccount.create({ clinic: clinicId, code: '4.2.90', name: 'Ganancia baja (custom)', type: 'INGRESO', nature: 'CREDITO', allowsMovement: true });
  await AccountingConfig.create({ clinic: clinicId, accounts: { otrosIngresos: otrosIngresosCustom._id } });

  // Baja con valor > libro (1000) → ganancia 500 sin banco (ingreso por Caja).
  const r = await H.runController(inv.disposeAsset, H.mockReq(clinicId, userId, { disposalValue: 1500, disposalDate: new Date('2026-06-20') }, { params: { id: String(asset._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  assert.equal(await H.accountBalanceByCode(clinicId, '4.2.90'), -500, 'la ganancia usa la cuenta remapeada por rol');
  assert.equal(await H.accountBalanceByCode(clinicId, '4.2.02'), 0, 'NO usa el código fijo por defecto');
  assert.equal(await H.accountBalanceByCode(clinicId, assetAcc.code), 0, 'el activo se da de baja (1000 al haber neteado con el debe de compra)');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);

  const entry = await JournalEntry.findOne({ clinic: clinicId, source: 'AJUSTE', sourceModel: 'FixedAsset', sourceAction: 'DISPOSE' });
  assert.ok(entry, 'asiento de baja con trazabilidad FixedAsset/DISPOSE');
});

// ─────────────────────────────────────────────────────────────────────────────
// T4 (K2) — Cobro de una venta (Sale) a crédito por el flujo de Payment.
test('T4) cobro de venta (Sale) por Payment: baja CxC y contabiliza', async () => {
  const { clinicId, userId } = await setupPurchases();
  const prod = await H.makeProduct(clinicId, { category: 'servicio', unlimited: true, salePrice: 100, taxRate: 0, priceIncludesVat: false });
  const saleRes = await H.runController(sales.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: String(prod._id), quantity: 1, unitPrice: 100 }],
    clientName: 'Cliente crédito', paymentMethod: 'credito', date: new Date('2026-06-10'),
  }));
  assert.equal(saleRes.statusCode, 201, JSON.stringify(saleRes.payload));
  const saleId = saleRes.payload._id;
  const saleTotal = saleRes.payload.total; // total con impuestos, sea cual sea la tarifa

  // Cobro por Payment aplicando a la venta (docModel 'Sale' — antes rompía el esquema).
  const payRes = await H.runController(payments.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'EFECTIVO', date: new Date('2026-06-11'),
    partyModel: 'Patient', partyName: 'Cliente crédito',
    applications: [{ docModel: 'Sale', docRef: String(saleId), amount: saleTotal }],
  }));
  assert.equal(payRes.statusCode, 201, JSON.stringify(payRes.payload));

  const payment = await Payment.findById(payRes.payload._id);
  assert.equal(payment.applications[0].docModel, 'Sale', 'el cobro de una venta (Sale) ya no rompe el esquema (K2)');
  const sale = await Sale.findById(saleId);
  assert.equal(sale.balance, 0, 'la venta queda cobrada');
  assert.equal(sale.paid, true);
  const rec = await Receivable.findOne({ clinic: clinicId, sourceModel: 'Sale', sourceRef: saleId });
  assert.ok(rec && rec.balance === 0, 'CxC (subledger) aplicada a cero');
  // Asiento del cobro: D caja / H clientes.
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), saleTotal, 'caja debitada por el cobro');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
// T5 — Guarda anti-sobrepago: un pago que excede el saldo de la compra se bloquea.
test('T5) pago que excede el saldo de la compra se bloquea', async () => {
  const { clinicId, userId } = await setupPurchases();
  const sup = await H.makeSupplier(clinicId);
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  // Compra gasto 100 sin retención → CxP 100.
  const pr = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Gasto', lineType: 'GASTO', account: gasto._id, quantity: 1, unitPrice: 100, ivaRate: 0, subtotal: 100 }],
  }));
  assert.equal(pr.statusCode, 201, JSON.stringify(pr.payload));
  const r = await H.runController(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyName: 'Prov',
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(pr.payload._id), amount: 150 }],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /excede el saldo/i);
});

// ─────────────────────────────────────────────────────────────────────────────
// T6 — Trazabilidad: todo asiento AUTOMÁTICO lleva source, sourceModel y sourceRef.
test('T6) todo asiento automático tiene source/sourceModel/sourceRef', async () => {
  const { clinicId, userId, invCat, ruleRenta } = await setupPurchases();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 10, unitPrice: 10, ivaRate: 15, subtotal: 100, retentions: [{ rule: String(ruleRenta._id) }] }],
  }));
  const svc = await H.makeProduct(clinicId, { category: 'servicio', unlimited: true, salePrice: 50, taxRate: 0, priceIncludesVat: false });
  await H.runController(sales.createSale, H.mockReq(clinicId, userId, { items: [{ product: String(svc._id), quantity: 1, unitPrice: 50 }], clientName: 'C', paymentMethod: 'efectivo', date: new Date('2026-06-06') }));

  const AUTO = ['VENTA', 'COMPRA', 'PAGO', 'COBRO', 'NOMINA', 'DEPRECIACION', 'BANCO', 'CIERRE', 'CAJA', 'NC', 'ND'];
  const autoEntries = await JournalEntry.find({ clinic: clinicId, status: 'CONTABILIZADO', source: { $in: AUTO } });
  assert.ok(autoEntries.length >= 2, 'hay asientos automáticos');
  for (const e of autoEntries) {
    assert.ok(e.sourceModel, `asiento ${e.number} (${e.source}) sin sourceModel`);
    assert.ok(e.sourceRef, `asiento ${e.number} (${e.source}) sin sourceRef`);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// T7 — Guarda: contabilizar en un período CERRADO se bloquea.
test('T7) período cerrado bloquea la contabilización', async () => {
  const { clinicId, userId, invCat } = await setupPurchases();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', stock: 0, inventoryCategory: invCat._id });
  // Cierra el período de julio 2026.
  await FiscalPeriod.updateOne({ clinic: clinicId, year: 2026, month: 7 }, { $set: { clinic: clinicId, year: 2026, month: 7, status: 'CERRADO' } }, { upsert: true });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-07-05'),
    items: [{ description: 'Insumo', lineType: 'INVENTARIO', product: prod._id, quantity: 1, unitPrice: 10, ivaRate: 0, subtotal: 10 }],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /no esta abierto|no está abierto|periodo|período/i);
});
