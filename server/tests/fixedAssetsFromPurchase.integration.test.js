/**
 * BLOQUE A · ACTIVOS FIJOS QUE NACEN DE UNA COMPRA.
 *
 * Cierra los tres bugs reales de la integración anterior:
 *   · una línea de N unidades creaba UN activo con el costo de toda la línea;
 *   · re-contabilizar la compra borraba y recreaba, DUPLICANDO los activos ya depreciados;
 *   · nadie veía por qué "el activo no aparece" (compra importada = POR_AUTORIZAR).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const invCtrl = require('../controllers/inventoryAdvancedController');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const FixedAsset = require('../models/FixedAsset');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { plannedAssetUnits } = require('../services/fixedAssetsFromPurchase');
const { diagnose } = require('../scripts/diagnoseFixedAssetsFromPurchases');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// Los comprobantes ya no admiten fecha anterior a hoy (utils/fiscalDocumentDate), así que
// estas pruebas trabajan sobre HOY y el MES EN CURSO en vez de sobre un mes fijo del calendario.
const Y = new Date().getFullYear();
const M = new Date().getMonth() + 1;

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const assetAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.05.10', name: 'Equipos', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const depAcc = await ChartOfAccount.create({ clinic: clinicId, code: '5.2.10', name: 'Gasto depreciación', type: 'GASTO', nature: 'DEBITO', allowsMovement: true });
  const accumAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.90.10', name: 'Dep. acumulada', type: 'ACTIVO', nature: 'CREDITO', allowsMovement: true });
  const cat = await InventoryCategory.create({
    clinic: clinicId, code: 'AF-PC', name: 'Equipos de computación', kind: 'ACTIVO_FIJO',
    assetAccount: assetAcc._id, depreciationAccount: depAcc._id, accumDepreciationAccount: accumAcc._id,
    usefulLifeMonths: 10, residualPercent: 0, expenseType: 'ADMINISTRATIVO',
  });
  const sup = await H.makeSupplier(clinicId);
  return { clinicId, userId, assetAcc, depAcc, accumAcc, cat, sup };
}

/** Línea de activo fijo con cantidad. `subtotal` es el de la LÍNEA (unitPrice × cantidad). */
const afLine = (catId, { qty = 1, unit = 1000, name = 'Laptop' } = {}) => ({
  description: name, lineType: 'ACTIVO_FIJO', quantity: qty, unitPrice: unit, ivaRate: 0,
  subtotal: +(qty * unit).toFixed(2), fixedAsset: { category: catId, name },
});
const gastoLine = (accId, val = 50) => ({
  description: 'Servicio', lineType: 'GASTO', quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val, account: accId,
});
const crearCompra = (clinicId, userId, sup, items, extra = {}) => run(purchase.create, H.mockReq(clinicId, userId, {
  supplier: sup._id, fechaEmision: H.docDate(), serie: `001-001-${Math.floor(Math.random() * 1e9)}`,
  items, ...extra,
}));

// ══════════════════════════ CREACIÓN ══════════════════════════

test('A1) compra manual: una línea de 3 unidades crea TRES activos, cada uno con SU costo', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const inv = ok(await crearCompra(clinicId, userId, sup, [afLine(cat._id, { qty: 3, unit: 1000 })]));

  const assets = await FixedAsset.find({ clinic: clinicId, purchaseInvoice: inv._id }).sort({ purchaseUnitIndex: 1 });
  assert.equal(assets.length, 3, 'tres monitores son tres activos, no uno');
  for (const [i, a] of assets.entries()) {
    assert.equal(a.acquisitionCost, 1000, 'cada activo vale lo suyo, no la línea entera');
    assert.equal(a.purchaseLineIndex, 0);
    assert.equal(a.purchaseUnitIndex, i);
    assert.equal(a.monthlyDepreciation, 100, '1000/10 por unidad');
    assert.equal(String(a.supplier), String(sup._id), 'conserva el proveedor');
    assert.ok(a.journalEntry, 'y el asiento origen');
    assert.equal(a.name, `Laptop (${i + 1}/3)`);
  }
  // La suma de los activos es exactamente el subtotal de la línea (cuadra con el asiento).
  assert.equal(assets.reduce((s, a) => s + a.acquisitionCost, 0), 3000);
});

test('A2) el redondeo no se pierde: 1.000,00 en 3 unidades suma exactamente el subtotal', () => {
  const unidades = plannedAssetUnits({
    items: [{ lineType: 'ACTIVO_FIJO', quantity: 3, subtotal: 1000 }],
  });
  assert.equal(unidades.length, 3);
  assert.deepEqual(unidades.map((u) => u.cost), [333.33, 333.33, 333.34]);
  assert.equal(unidades.reduce((s, u) => s + u.cost, 0), 1000);
});

test('A3) compra MIXTA: solo las líneas de activo fijo generan activos', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const inv = ok(await crearCompra(clinicId, userId, sup, [
    gastoLine(String(gasto._id), 50),
    afLine(cat._id, { qty: 2, unit: 500, name: 'Monitor' }),
    gastoLine(String(gasto._id), 30),
  ]));

  const assets = await FixedAsset.find({ clinic: clinicId, purchaseInvoice: inv._id });
  assert.equal(assets.length, 2, 'solo la línea 2 genera activos');
  assert.ok(assets.every((a) => a.purchaseLineIndex === 1), 'con el índice de SU línea');
  assert.ok(assets.every((a) => a.acquisitionCost === 500));
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('A4) compra IMPORTADA (POR_AUTORIZAR): no hay activos hasta contabilizar, y al autorizar aparecen', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  // Una compra importada por XML/TXT nace POR_AUTORIZAR: los activos NO existen todavía.
  const imp = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: H.docDate(),
    serie: '001-001-000123456', status: 'POR_AUTORIZAR', subtotal: 2000, total: 2000, balance: 2000,
    items: [afLine(cat._id, { qty: 2, unit: 1000 })], createdBy: userId,
  });
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 0,
    'ésta es la causa nº1 de "el activo no aparece": la compra no está contabilizada');

  const r = await run(purchase.authorize, H.mockReq(clinicId, userId, {}, { params: { id: String(imp._id) } }));
  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId, purchaseInvoice: imp._id }), 2,
    'al autorizarla (= contabilizarla) se crean sus activos');
});

// ══════════════════════════ IDEMPOTENCIA ══════════════════════════

test('A5) re-contabilizar la compra NO duplica activos (identidad compra+línea+unidad)', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const inv = ok(await crearCompra(clinicId, userId, sup, [afLine(cat._id, { qty: 2, unit: 1000 })]));
  const antes = await FixedAsset.find({ clinic: clinicId }).sort({ purchaseUnitIndex: 1 });
  assert.equal(antes.length, 2);

  // Editar la compra la vuelve a contabilizar (postPurchaseJournal + sync).
  ok(await run(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [afLine(cat._id, { qty: 2, unit: 1000 })],
  }, { params: { id: String(inv._id) } })));

  const despues = await FixedAsset.find({ clinic: clinicId }).sort({ purchaseUnitIndex: 1 });
  assert.equal(despues.length, 2, 'siguen siendo dos');
  assert.deepEqual(despues.map((a) => String(a._id)), antes.map((a) => String(a._id)),
    'y son LOS MISMOS: se reconocen por identidad, no se borran y recrean');
});

test('A6) el activo YA DEPRECIADO no se duplica ni se reescribe al re-contabilizar', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const inv = ok(await crearCompra(clinicId, userId, sup, [afLine(cat._id, { qty: 1, unit: 1000 })]));
  ok(await run(invCtrl.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M })));
  const dep = await FixedAsset.findOne({ clinic: clinicId });
  assert.equal(dep.accumulatedDepreciation, 100);

  // Antes esto creaba un SEGUNDO activo (el borrado solo alcanzaba a los no depreciados).
  ok(await run(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [afLine(cat._id, { qty: 1, unit: 1000 })],
  }, { params: { id: String(inv._id) } })));

  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 1, 'sigue habiendo UN activo');
  const igual = await FixedAsset.findById(dep._id);
  assert.equal(igual.accumulatedDepreciation, 100, 'y conserva su depreciación');
});

test('A7) cambiar el costo de una compra cuyo activo ya se depreció se BLOQUEA', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const inv = ok(await crearCompra(clinicId, userId, sup, [afLine(cat._id, { qty: 1, unit: 1000 })]));
  ok(await run(invCtrl.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M })));

  const r = await run(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [afLine(cat._id, { qty: 1, unit: 2500 })],   // otro costo
  }, { params: { id: String(inv._id) } }));
  assert.equal(r.statusCode, 400);
  assert.ok(/depreciación/i.test(r.payload.message));
  const a = await FixedAsset.findOne({ clinic: clinicId });
  assert.equal(a.acquisitionCost, 1000, 'el costo del activo depreciado no se reescribe');
});

// ══════════════════════════ ANULACIÓN ══════════════════════════

test('A8) anular la compra borra el activo SIN historia', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const inv = ok(await crearCompra(clinicId, userId, sup, [afLine(cat._id, { qty: 2, unit: 1000 })]));
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 2);

  const r = await run(purchase.void, H.mockReq(clinicId, userId, {}, { params: { id: String(inv._id) } }));
  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 0, 'nunca existieron económicamente');
});

test('A9) anular una compra con activo DEPRECIADO se bloquea (no se destruyen asientos)', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const inv = ok(await crearCompra(clinicId, userId, sup, [afLine(cat._id, { qty: 1, unit: 1000 })]));
  ok(await run(invCtrl.runDepreciation, H.mockReq(clinicId, userId, { year: Y, month: M })));

  const r = await run(purchase.void, H.mockReq(clinicId, userId, {}, { params: { id: String(inv._id) } }));
  assert.equal(r.statusCode, 400);
  assert.ok(/depreciación|baja/i.test(r.payload.message));
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 1, 'el activo con historia sobrevive');
  assert.equal((await PurchaseInvoice.findById(inv._id)).status, 'REGISTRADA', 'y la compra NO se anuló');
});

// ══════════════════════════ DIAGNÓSTICO / BACKFILL ══════════════════════════

test('A10) el diagnóstico detecta faltantes, no contabilizadas y ambiguas; --commit solo crea lo seguro', async () => {
  const { clinicId, userId, cat, sup } = await setup();

  // (a) compra contabilizada a la que le faltan unidades (el bug viejo: 1 activo por línea).
  const inv = ok(await crearCompra(clinicId, userId, sup, [afLine(cat._id, { qty: 3, unit: 1000 })]));
  await FixedAsset.deleteMany({ clinic: clinicId, purchaseUnitIndex: { $gt: 0 } });   // simula el histórico
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 1);

  // (b) compra importada sin contabilizar.
  await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, fechaEmision: H.docDate(),
    serie: '001-001-000999', status: 'POR_AUTORIZAR', subtotal: 500, total: 500, balance: 500,
    items: [afLine(cat._id, { qty: 1, unit: 500 })], createdBy: userId,
  });

  const seco = await diagnose({ clinic: clinicId });
  assert.equal(seco.faltantes, 2, 'faltan las unidades 2 y 3');
  assert.equal(seco.sinContabilizar, 1, 'y avisa de la importada');
  assert.equal(seco.creados, 0, 'dry-run: no escribe');
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 1);

  const húmedo = await diagnose({ clinic: clinicId, commit: true, userId });
  assert.equal(húmedo.creados, 2);
  const assets = await FixedAsset.find({ clinic: clinicId, purchaseInvoice: inv._id }).sort({ purchaseUnitIndex: 1 });
  assert.equal(assets.length, 3, 'las unidades que faltaban');
  assert.deepEqual(assets.map((a) => a.acquisitionCost), [1000, 1000, 1000]);
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId, purchaseLineIndex: null }), 0);
});

test('A11) el diagnóstico NO toca los casos ambiguos (activo con el costo de la línea completa)', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const inv = ok(await crearCompra(clinicId, userId, sup, [afLine(cat._id, { qty: 2, unit: 1000 })]));
  // Histórico del bug viejo: UN activo con el costo de la línea entera y sin las otras unidades.
  await FixedAsset.deleteMany({ clinic: clinicId, purchaseUnitIndex: 1 });
  await FixedAsset.updateOne({ clinic: clinicId }, { $set: { acquisitionCost: 2000, bookValue: 2000 } });

  const r = await diagnose({ clinic: clinicId, commit: true, userId });
  assert.equal(r.ambiguos, 1);
  assert.equal(r.costoDeLinea, 1);
  assert.equal(r.creados, 0, 'crear la unidad que falta duplicaría el valor del activo: no se toca');
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId, purchaseInvoice: inv._id }), 1);
});

// ══════════════════════════ IDENTIDAD DE LÍNEA (auditoría de la Fase 3) ══════════════════════════

test('A13) borrar una línea intermedia NO rebindea el activo a la línea equivocada', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const inv = ok(await crearCompra(clinicId, userId, sup, [
    gastoLine(String(gasto._id), 50),                                  // línea 0
    afLine(cat._id, { qty: 1, unit: 1000, name: 'Laptop' }),           // línea 1
  ]));
  const antes = await FixedAsset.findOne({ clinic: clinicId });
  assert.equal(antes.purchaseLineIndex, 1);
  assert.ok(antes.purchaseLineId, 'el activo guarda la identidad ESTABLE de su línea');

  // Se borra la línea de gasto: el activo pasa a ser la línea 0. Con identidad posicional, el
  // activo se habría rebindeado a la línea equivocada (o se habría borrado y recreado).
  const doc = await PurchaseInvoice.findById(inv._id);
  const lineaAF = doc.items[1].toObject();
  ok(await run(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [{ ...lineaAF, fixedAsset: { category: cat._id, name: 'Laptop' } }],
  }, { params: { id: String(inv._id) } })));

  const despues = await FixedAsset.find({ clinic: clinicId });
  assert.equal(despues.length, 1, 'sigue habiendo UN activo');
  assert.equal(String(despues[0]._id), String(antes._id), 'y es EL MISMO (lo reconoce su lineId)');
  assert.equal(despues[0].purchaseLineIndex, 0, 'reanclado a su nueva posición');
  assert.equal(despues[0].acquisitionCost, 1000, 'con su costo intacto');
});

test('A14) una cantidad DECIMAL de activo fijo se rechaza (no se redondea a la callada)', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const r = await crearCompra(clinicId, userId, sup, [{
    description: 'Laptop', lineType: 'ACTIVO_FIJO', quantity: 2.5, unitPrice: 400, ivaRate: 0,
    subtotal: 1000, fixedAsset: { category: cat._id, name: 'Laptop' },
  }]);
  assert.equal(r.statusCode, 400);
  assert.ok(/decimal|entera/i.test(r.payload.message));
  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId }), 0);
});

test('A15) el costo capitalizable se reparte exacto: 7 unidades por 10,00', () => {
  const u = plannedAssetUnits({ items: [{ lineType: 'ACTIVO_FIJO', quantity: 7, subtotal: 10 }] });
  assert.equal(u.length, 7);
  assert.equal(u.reduce((s, x) => s + x.cost, 0), 10, 'Σ unidades = costo capitalizable de la línea');
  assert.deepEqual(u.map((x) => x.cost), [1.43, 1.43, 1.43, 1.43, 1.43, 1.43, 1.42]);
});

test('A16) dos contabilizaciones SIMULTÁNEAS no crean unidades duplicadas', async () => {
  const { clinicId, userId, cat, sup } = await setup();
  const inv = ok(await crearCompra(clinicId, userId, sup, [afLine(cat._id, { qty: 2, unit: 500 })]));

  const editar = () => run(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(),
    items: [afLine(cat._id, { qty: 2, unit: 500 })],
  }, { params: { id: String(inv._id) } }));
  await Promise.allSettled([editar(), editar()]);

  assert.equal(await FixedAsset.countDocuments({ clinic: clinicId, purchaseInvoice: inv._id }), 2,
    'el índice único (compra, línea, unidad) impide la duplicación en carrera');
});

test('A12) dos clínicas: los activos no se cruzan', async () => {
  const a = await setup();
  const b = await setup();
  ok(await crearCompra(a.clinicId, a.userId, a.sup, [afLine(a.cat._id, { qty: 2, unit: 1000 })]));
  ok(await crearCompra(b.clinicId, b.userId, b.sup, [afLine(b.cat._id, { qty: 1, unit: 700 })]));

  assert.equal(await FixedAsset.countDocuments({ clinic: a.clinicId }), 2);
  assert.equal(await FixedAsset.countDocuments({ clinic: b.clinicId }), 1);
  const dA = await diagnose({ clinic: a.clinicId });
  assert.equal(dA.unidadesEsperadas, 2, 'la clínica A no ve las compras de la B');
  assert.equal(dA.faltantes, 0);
});
