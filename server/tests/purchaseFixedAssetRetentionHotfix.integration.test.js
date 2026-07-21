/**
 * HOTFIX · COMPRA CON ACTIVO FIJO + RETENCIÓN (bug reproducido en la reunión).
 *
 * En la reunión, al EDITAR una compra con una línea de activo fijo, y al AGREGARLE una RETENCIÓN,
 * el sistema reventaba con el crudo:
 *   E11000 duplicate key error collection: clinica_db.fixedassets index: clinic_1_code_1
 *          dup key: { clinic: …, code: "actf-computo" }
 * Causa: al re-guardar la compra, la generación de activos NO reconocía el activo ya existente
 * (activo legacy sin identidad de línea, o línea reordenada sin conservar `lineId`) e intentaba
 * CREAR otro con el mismo código personalizado, chocando con el índice único {clinic, code}.
 *
 * Estos tests reproducen los DOS flujos que fallaron y verifican que:
 *   · reprocesar la compra ADOPTA el activo existente (no crea un duplicado);
 *   · agregar una retención guarda la retención y no toca los activos;
 *   · un E11000 real llega al usuario como 409 legible, nunca como el texto crudo de Mongo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const invAdv = require('../controllers/inventoryAdvancedController');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const RetentionRule = require('../models/RetentionRule');
const FixedAsset = require('../models/FixedAsset');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const { formatError } = require('../utils/apiError');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: new Date('2026-06-01') });
  const assetAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.05.10', name: 'Equipo de cómputo', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const depAcc = await ChartOfAccount.create({ clinic: clinicId, code: '5.2.10', name: 'Gasto depreciación', type: 'GASTO', nature: 'DEBITO', allowsMovement: true });
  const accumAcc = await ChartOfAccount.create({ clinic: clinicId, code: '1.2.90.10', name: 'Dep. acumulada', type: 'ACTIVO', nature: 'CREDITO', allowsMovement: true });
  const cat = await InventoryCategory.create({
    clinic: clinicId, code: 'AF-PC', name: 'Equipos de computación', kind: 'ACTIVO_FIJO',
    assetAccount: assetAcc._id, depreciationAccount: depAcc._id, accumDepreciationAccount: accumAcc._id,
    usefulLifeMonths: 36, residualPercent: 0, expenseType: 'ADMINISTRATIVO',
  });
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  // Reglas de catálogo (rates limpios): renta bienes 2% y retención de IVA 30%.
  const ruleBienes = await RetentionRule.create({ clinic: clinicId, type: 'RENTA', code: '312', description: 'Compra de bienes', rate: 2, appliesTo: 'BIENES', baseType: 'SUBTOTAL_TOTAL' });
  const ruleIva = await RetentionRule.create({ clinic: clinicId, type: 'IVA', code: '721', description: 'Retención IVA 30%', rate: 30, appliesTo: 'BIENES', baseType: 'IVA' });
  const sup = await H.makeSupplier(clinicId);
  return { clinicId, userId, cat, gasto, sup, ruleBienes, ruleIva };
}

/** Línea de activo fijo con CÓDIGO personalizado (como el "actf-computo" de la reunión). */
const afLine = (catId, { code = 'actf-computo', name = 'Equipo de cómputo', unit = 350, ivaRate = 15, ret } = {}) => ({
  description: name, lineType: 'ACTIVO_FIJO', quantity: 1, unitPrice: unit, ivaRate,
  subtotal: unit, fixedAsset: { category: catId, name, code }, ...(ret ? { retentions: ret } : {}),
});
const gastoLine = (accId, { val = 25, ivaRate = 15 } = {}) => ({
  description: 'Servicio', lineType: 'GASTO', quantity: 1, unitPrice: val, ivaRate, subtotal: val, account: accId,
});

// La compra real de la reunión: servicio 25 + activo fijo 350 = 375 subtotal, IVA 56.25, total 431.25.
const crearCompraReunion = (clinicId, userId, sup, cat, gasto, extraAsset = {}) => run(purchase.create, H.mockReq(clinicId, userId, {
  supplier: sup._id, fechaEmision: new Date('2026-06-05'), serie: `001-001-${Math.floor(Math.random() * 1e9)}`,
  items: [gastoLine(gasto._id), afLine(cat._id, extraAsset)],
}));

// ════════════════════════ FLUJO 1: EDITAR compra con activo fijo ════════════════════════

test('H1) EDITAR una compra con activo fijo LEGACY (sin identidad de línea) NO revienta con E11000', async () => {
  const { clinicId, userId, cat, gasto, sup } = await setup();
  const inv = ok(await crearCompraReunion(clinicId, userId, sup, cat, gasto));
  assert.equal(inv.subtotal, 375);
  assert.equal(inv.iva, 56.25);
  assert.equal(inv.total, 431.25);
  const activo = await FixedAsset.findOne({ clinic: clinicId, code: 'actf-computo' });
  assert.ok(activo, 'la compra creó el activo con su código personalizado');

  // Simula un activo LEGACY: creado antes de que existieran los campos de identidad de línea.
  // Es el estado real en producción del activo "actf-computo" de la contadora.
  await FixedAsset.updateOne({ _id: activo._id }, { $set: { purchaseLineIndex: null, purchaseUnitIndex: null, purchaseLineId: null } });

  // Editar y guardar la compra (mismo comprobante) la vuelve a contabilizar. Antes: E11000.
  const upd = await run(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [gastoLine(gasto._id), afLine(cat._id)],
  }, { params: { id: String(inv._id) } }));
  assert.ok(upd.statusCode < 400, `no debe reventar: ${JSON.stringify(upd.payload)}`);

  const activos = await FixedAsset.find({ clinic: clinicId, code: 'actf-computo' });
  assert.equal(activos.length, 1, 'sigue habiendo UN activo (se adoptó el existente, no se duplicó)');
  assert.equal(String(activos[0]._id), String(activo._id), 'y es EL MISMO activo');
  assert.equal(activos[0].purchaseLineIndex, 1, 'el activo legacy quedó reanclado a su línea');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('H2) EDITAR quitando una línea (el activo cambia de índice) sin conservar lineId NO duplica el activo', async () => {
  const { clinicId, userId, cat, gasto, sup } = await setup();
  const inv = ok(await crearCompraReunion(clinicId, userId, sup, cat, gasto));
  const activo = await FixedAsset.findOne({ clinic: clinicId, code: 'actf-computo' });
  assert.equal(activo.purchaseLineIndex, 1, 'nació en la línea 1 (tras el servicio)');

  // Se quita la línea de servicio: el activo pasa a ser la línea 0. El front NO reenvía el `lineId`
  // (lo regenera en cada envío), así que la única pista sería el índice… que también cambió.
  const upd = await run(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [afLine(cat._id)],   // sin lineId, activo ahora en índice 0
  }, { params: { id: String(inv._id) } }));
  assert.ok(upd.statusCode < 400, `no debe reventar: ${JSON.stringify(upd.payload)}`);

  const activos = await FixedAsset.find({ clinic: clinicId, code: 'actf-computo' });
  assert.equal(activos.length, 1, 'un solo activo: se reconoció por su código y se reancló');
  assert.equal(String(activos[0]._id), String(activo._id));
  assert.equal(activos[0].purchaseLineIndex, 0, 'reanclado a su nueva posición');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ════════════════════════ FLUJO 2: AGREGAR retención sobre la compra ════════════════════════

test('H3) AGREGAR una retención renta+IVA a una compra con activo fijo NO revienta y guarda la retención', async () => {
  const { clinicId, userId, cat, gasto, sup, ruleBienes, ruleIva } = await setup();
  const inv = ok(await crearCompraReunion(clinicId, userId, sup, cat, gasto));
  const activoId = String((await FixedAsset.findOne({ clinic: clinicId, code: 'actf-computo' }))._id);

  // Simula el activo legacy (el caso de la contadora) para exponer el bug al re-guardar.
  await FixedAsset.updateOne({ code: 'actf-computo' }, { $set: { purchaseLineIndex: null, purchaseUnitIndex: null, purchaseLineId: null } });

  // "Agregarle una retención" = re-guardar la compra con la retención en la línea del activo.
  const upd = await run(purchase.update, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'),
    items: [
      gastoLine(gasto._id),
      afLine(cat._id, { ret: [{ rule: String(ruleBienes._id) }, { rule: String(ruleIva._id) }] }),
    ],
  }, { params: { id: String(inv._id) } }));
  assert.ok(upd.statusCode < 400, `agregar retención no debe reventar: ${JSON.stringify(upd.payload)}`);

  const saved = await PurchaseInvoice.findById(inv._id);
  assert.ok(saved.retentionTotal > 0, 'la retención SÍ se guardó (antes no llegaba a guardarse)');
  assert.ok((saved.retentions || []).some((r) => r.code === '312'), 'renta 312 en la cabecera');
  assert.ok((saved.retentions || []).some((r) => r.code === '721'), 'IVA 721 en la cabecera');

  // Los activos fijos NO se tocaron: sigue habiendo UNO y es el mismo.
  const activos = await FixedAsset.find({ clinic: clinicId, code: 'actf-computo' });
  assert.equal(activos.length, 1, 'agregar una retención no crea ni duplica activos');
  assert.equal(String(activos[0]._id), activoId, 'y es el mismo activo de antes');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

test('H4) la retención queda con su ENCABEZADO disponible para el modal (número/estado/fecha/periodo)', async () => {
  const { clinicId, userId, cat, gasto, sup, ruleBienes } = await setup();
  const inv = ok(await run(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-05'), serie: '001-001-000123456',
    items: [gastoLine(gasto._id), afLine(cat._id, { ret: [{ rule: String(ruleBienes._id) }] })],
  })));
  // Al reabrir la compra (GET), el encabezado de retención debe poder construirse: la factura
  // conserva fechaEmision (fecha), estab/ptoEmi/secuencial o retentionNumber (número), y las líneas.
  const got = ok(await run(purchase.get, H.mockReq(clinicId, userId, {}, { params: { id: String(inv._id) } })));
  assert.ok(got.retentions && got.retentions.length, 'la compra devuelve sus retenciones al abrir');
  assert.ok(got.fechaEmision, 'con fecha de emisión (parte del encabezado)');
  const r312 = got.retentions.find((r) => r.code === '312');
  assert.ok(r312 && r312.amount > 0, 'con la línea de retención y su monto');
});

// ════════════════════════ TASK 2: E11000 → 409 legible ════════════════════════

test('H5) un E11000 real NO llega crudo al usuario: 409 con mensaje legible', async () => {
  const { clinicId, userId, cat } = await setup();
  // Crear un activo manual con un código, y luego otro con el MISMO código → choque de índice único.
  const base = { category: String(cat._id), name: 'Laptop', code: 'DUP-1', acquisitionCost: 500, cost: 500 };
  const r1 = await run(invAdv.createAsset, H.mockReq(clinicId, userId, base));
  assert.equal(r1.statusCode, 201, JSON.stringify(r1.payload));
  const r2 = await run(invAdv.createAsset, H.mockReq(clinicId, userId, { ...base, name: 'Otra laptop' }));
  assert.equal(r2.statusCode, 409, 'clave duplicada → 409');
  assert.match(r2.payload.message, /Ya existe un registro/i, 'mensaje legible');
  assert.doesNotMatch(r2.payload.message, /E11000|dup key|index:/i, 'nunca el texto crudo de Mongo');
});

test('H6) formatError traduce E11000 con la entidad y el campo en conflicto', () => {
  const err = Object.assign(new Error('E11000 duplicate key error collection: clinica_db.fixedassets index: clinic_1_code_1 dup key: { clinic: 1, code: "actf-computo" }'), {
    code: 11000, keyValue: { clinic: 'x', code: 'actf-computo' }, keyPattern: { clinic: 1, code: 1 },
  });
  const { status, body } = formatError(err);
  assert.equal(status, 409);
  assert.match(body.message, /Activos fijos/);
  assert.match(body.message, /actf-computo/);
  assert.doesNotMatch(body.message, /clinic/, 'no expone la clave multi-tenant');
});
