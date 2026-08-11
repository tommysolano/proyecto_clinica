/**
 * BLOQUES B, C, D, E · KARDEX VALORIZADO, TRASLADOS, TOMAS FÍSICAS Y CENTRO DE COSTO POR BODEGA.
 *
 * Los tres bugs que cierran estas pruebas:
 *   · el kardex arrancaba en CERO y ordenaba por `createdAt` (fecha técnica);
 *   · un traslado era UN movimiento al que el kardex daba signo 0: no aparecía ni en el origen
 *     ni en el destino;
 *   · la toma física ajustaba SIN bodega: creaba capas con `warehouse: null` y consumía FIFO de
 *     cualquier bodega, corrompiendo las existencias.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/inventoryAdvancedController');
const svc = require('../services/kardexService');
const kardex = require('../utils/kardex');
const Warehouse = require('../models/Warehouse');
const CostCenter = require('../models/CostCenter');
const Product = require('../models/Product');
const InventoryMovement = require('../models/InventoryMovement');
const InventoryLayer = require('../models/InventoryLayer');
const InventoryCategory = require('../models/InventoryCategory');
const PhysicalCount = require('../models/PhysicalCount');
const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const d = (s) => new Date(`${s}T12:00:00`);

async function setup() {
  const { clinicId, userId } = await H.seedClinic({ date: d('2026-06-01') });
  const A = await Warehouse.create({ clinic: clinicId, code: 'A', name: 'Bodega A' });
  const B = await Warehouse.create({ clinic: clinicId, code: 'B', name: 'Bodega B' });
  const prod = await H.makeProduct(clinicId, { code: 'P1', name: 'Insumo', stock: 0 });
  return { clinicId, userId, A, B, prod };
}

/** Entrada real de stock: capa + movimiento valorizado con FECHA FUNCIONAL. */
async function entrada(clinicId, userId, { product, warehouse, qty, cost, date }) {
  await kardex.receiveStock({
    clinicId, product: product._id, warehouse: warehouse._id, quantity: qty, unitCost: cost,
    date, sourceModel: 'PurchaseInvoice', sourceRef: product._id, userId,
  });
  const cur = await kardex.currentStock({ clinicId, product: product._id, warehouse: warehouse._id });
  await Product.updateOne({ _id: product._id }, { $inc: { stock: qty } });
  return InventoryMovement.create({
    clinic: clinicId, product: product._id, type: 'entrada', warehouse: warehouse._id,
    quantity: qty, unitCost: cost, totalCost: +(qty * cost).toFixed(2), balanceAfter: cur.qty,
    movementDate: date, dateSource: 'DOCUMENTO', reason: 'Compra', reference: 'F-001',
    sourceModel: 'PurchaseInvoice', sourceRef: product._id, createdBy: userId,
  });
}

/** Salida real (venta): consume FIFO y graba el COGS. */
async function salida(clinicId, userId, { product, warehouse, qty, date }) {
  const issue = await kardex.issueStock({
    clinicId, product: product._id, warehouse: warehouse._id, quantity: qty,
  });
  const cur = await kardex.currentStock({ clinicId, product: product._id, warehouse: warehouse._id });
  await Product.updateOne({ _id: product._id }, { $inc: { stock: -qty } });
  return InventoryMovement.create({
    clinic: clinicId, product: product._id, type: 'salida', warehouse: warehouse._id,
    quantity: qty, unitCost: +(issue.totalCost / qty).toFixed(4), totalCost: issue.totalCost,
    balanceAfter: cur.qty, movementDate: date, dateSource: 'DOCUMENTO',
    layerConsumption: issue.consumption.map((c) => ({ layer: c.layerId, qty: c.qty, unitCost: c.unitCost })),
    reason: 'Venta', sourceModel: 'Sale', sourceRef: product._id, createdBy: userId,
  });
}

// ══════════════════════ BLOQUE B · KARDEX ══════════════════════

test('B1) el kardex NO arranca en cero: trae el saldo inicial anterior al rango', async () => {
  const { clinicId, userId, A, prod } = await setup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 5, cost: 8, date: d('2026-06-20') });

  const k = await svc.buildKardex(clinicId, { product: prod._id, from: '2026-06-15', to: '2026-06-30' });
  assert.equal(k.saldoInicial.qty, 10, 'las 10 unidades de antes del rango');
  assert.equal(k.saldoInicial.value, 50, 'valoradas a su costo real');
  assert.equal(k.rows.length, 1, 'solo el movimiento del rango');
  assert.equal(k.rows[0].saldoQty, 15, 'y el primer movimiento CONTINÚA desde el saldo inicial');
  assert.equal(k.rows[0].saldoValor, 90);
  assert.equal(k.saldoFinal.qty, 15);
  assert.equal(k.totales.cuadra, true, 'inicial + entradas − salidas = final');
});

test('B2) entrada valorizada, salida FIFO y COGS real (no el precio de compra de hoy)', async () => {
  const { clinicId, userId, A, prod } = await setup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 9, date: d('2026-06-05') });
  await salida(clinicId, userId, { product: prod, warehouse: A, qty: 12, date: d('2026-06-10') });
  // El precio de compra del producto cambia HOY: el kardex histórico no puede moverse.
  await Product.updateOne({ _id: prod._id }, { $set: { purchasePrice: 99 } });

  const k = await svc.buildKardex(clinicId, { product: prod._id });
  const venta = k.rows.find((r) => r.type === 'salida');
  // FIFO: 10 × 5 + 2 × 9 = 68
  assert.equal(venta.salidaValor, 68, 'COGS real de las capas consumidas');
  assert.equal(venta.saldoQty, 8);
  assert.equal(venta.saldoValor, 72, '8 unidades × 9 (la capa que queda)');
  assert.equal(venta.costoPromedio, 9);
  assert.equal(k.saldoFinal.value, 72);
});

test('B3) el kardex ordena por la fecha FUNCIONAL, y marca los históricos sin ella', async () => {
  const { clinicId, userId, A, prod } = await setup();
  // Movimiento histórico: no tiene `movementDate` (se grabó antes de que existiera el campo).
  await InventoryMovement.create({
    clinic: clinicId, product: prod._id, type: 'entrada', warehouse: A._id,
    quantity: 4, unitCost: 2, totalCost: 8, createdBy: userId,
  });
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 1, cost: 10, date: d('2026-06-10') });

  const k = await svc.buildKardex(clinicId, { product: prod._id });
  const historico = k.rows.find((r) => r.fechaEstimada);
  assert.ok(historico, 'el histórico aparece');
  assert.equal(historico.dateSource, 'CREATED_AT', 'y va MARCADO: su fecha es la de grabación');
  assert.equal(k.rows.filter((r) => r.dateSource === 'DOCUMENTO').length, 1);
  assert.equal(k.saldoFinal.qty, 5);
});

test('B4) documento y asiento son trazables desde cada fila', async () => {
  const { clinicId, userId, A, prod } = await setup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 3, cost: 7, date: d('2026-06-02') });
  const k = await svc.buildKardex(clinicId, { product: prod._id });
  assert.equal(k.rows[0].documento.model, 'PurchaseInvoice');
  assert.ok(k.rows[0].documento.ref, 'con su referencia para abrir la compra');
});

test('B5) el Excel del kardex sale del MISMO servicio que la API', async () => {
  const { clinicId, userId, A, prod } = await setup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  await salida(clinicId, userId, { product: prod, warehouse: A, qty: 4, date: d('2026-06-10') });

  const api = ok(await run(ctrl.getKardex, H.mockReq(clinicId, userId, {}, { query: { product: String(prod._id) } })));
  assert.equal(api.saldoFinal.qty, 6);
  assert.equal(api.saldoFinal.value, 30);
  assert.equal(api.totales.entradasValor, 50);
  assert.equal(api.totales.salidasValor, 20);
  assert.equal(api.movements.length, 2, 'la pantalla lee las mismas filas');
});

// ══════════════════════ BLOQUE C · TRASLADOS ══════════════════════

const trasladar = (clinicId, userId, body, idem) => run(
  ctrl.transferStock,
  H.mockReq(clinicId, userId, body, { headers: idem ? { 'idempotency-key': idem } : {} })
);

test('C1) un traslado se VE: salida en el origen, entrada en el destino, consolidado NETO CERO', async () => {
  const { clinicId, userId, A, B, prod } = await setup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });

  ok(await trasladar(clinicId, userId, {
    product: String(prod._id), fromWarehouse: String(A._id), toWarehouse: String(B._id),
    quantity: 4, date: '2026-06-10',
  }));

  const kA = await svc.buildKardex(clinicId, { product: prod._id, warehouse: A._id });
  const kB = await svc.buildKardex(clinicId, { product: prod._id, warehouse: B._id });
  const kTodo = await svc.buildKardex(clinicId, { product: prod._id });

  const salA = kA.rows.find((r) => r.esTraslado);
  assert.ok(salA, 'el traslado APARECE en la bodega origen (antes era invisible)');
  assert.equal(salA.salidaQty, 4);
  assert.equal(salA.salidaValor, 20, 'al costo de las capas, no al precio de venta');
  assert.equal(kA.saldoFinal.qty, 6);
  assert.equal(kA.saldoFinal.value, 30);

  const entB = kB.rows.find((r) => r.esTraslado);
  assert.ok(entB, 'y en la bodega destino');
  assert.equal(entB.entradaQty, 4);
  assert.equal(entB.entradaValor, 20, 'con el MISMO costo: un traslado no crea utilidad');
  assert.equal(kB.saldoFinal.qty, 4);
  assert.equal(kB.saldoFinal.value, 20);

  // Consolidado: el traslado no suma ni resta (es una reubicación).
  assert.equal(kTodo.saldoFinal.qty, 10, 'efecto global en unidades: CERO');
  assert.equal(kTodo.saldoFinal.value, 50, 'efecto global monetario: CERO');
  assert.equal(kTodo.totales.entradasQty, 10, 'el traslado no aparece como compra');
  assert.equal(kTodo.totales.salidasQty, 0, 'ni como venta');
});

test('C2) traslado sobre VARIAS capas FIFO: conserva el costo de cada una', async () => {
  const { clinicId, userId, A, B, prod } = await setup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 5, cost: 4, date: d('2026-06-01') });
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 5, cost: 10, date: d('2026-06-02') });

  ok(await trasladar(clinicId, userId, {
    product: String(prod._id), fromWarehouse: String(A._id), toWarehouse: String(B._id),
    quantity: 7, date: '2026-06-10',
  }));

  // 5×4 + 2×10 = 40
  const capasB = await InventoryLayer.find({ clinic: clinicId, warehouse: B._id }).sort({ unitCost: 1 });
  assert.equal(capasB.length, 2, 'llegan DOS capas, cada una con su costo');
  assert.deepEqual(capasB.map((c) => [c.qtyRemaining, c.unitCost]), [[5, 4], [2, 10]]);
  const kB = await svc.buildKardex(clinicId, { product: prod._id, warehouse: B._id });
  assert.equal(kB.saldoFinal.value, 40, 'el valor trasladado es el de las capas');
  const kA = await svc.buildKardex(clinicId, { product: prod._id, warehouse: A._id });
  assert.equal(kA.saldoFinal.value, 30, '3 unidades × 10 quedan en el origen');
});

test('C3) stock insuficiente en el origen: no se traslada nada', async () => {
  const { clinicId, userId, A, B, prod } = await setup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 2, cost: 5, date: d('2026-06-01') });

  const r = await trasladar(clinicId, userId, {
    product: String(prod._id), fromWarehouse: String(A._id), toWarehouse: String(B._id), quantity: 5,
  });
  assert.equal(r.statusCode, 400);
  assert.ok(/insuficiente/i.test(r.payload.message));
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, type: 'traslado' }), 0,
    'ni media pata: la transacción revierte entera');
  assert.equal(await InventoryLayer.countDocuments({ clinic: clinicId, warehouse: B._id }), 0);
});

test('C4) reintento con la misma clave: no duplica ninguna de las dos patas', async () => {
  const { clinicId, userId, A, B, prod } = await setup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  const body = {
    product: String(prod._id), fromWarehouse: String(A._id), toWarehouse: String(B._id),
    quantity: 3, date: '2026-06-10',
  };
  ok(await trasladar(clinicId, userId, body, 'tr-1'));
  const r2 = ok(await trasladar(clinicId, userId, body, 'tr-1'));
  assert.equal(r2.idempotentReplay, true);

  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, type: 'traslado' }), 2,
    'las dos patas del ÚNICO traslado');
  const kB = await svc.buildKardex(clinicId, { product: prod._id, warehouse: B._id });
  assert.equal(kB.saldoFinal.qty, 3, 'no se movió el doble');
});

test('C5) el traslado genera asiento de reclasificación y NO toca caja ni banco', async () => {
  const { clinicId, userId, A, B, prod } = await setup();
  const invA = await ChartOfAccount.create({ clinic: clinicId, code: '1.1.04.10', name: 'Inv. A', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const invB = await ChartOfAccount.create({ clinic: clinicId, code: '1.1.04.20', name: 'Inv. B', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  await Warehouse.updateOne({ _id: A._id }, { $set: { chartAccount: invA._id } });
  await Warehouse.updateOne({ _id: B._id }, { $set: { chartAccount: invB._id } });
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });

  const r = ok(await trasladar(clinicId, userId, {
    product: String(prod._id), fromWarehouse: String(A._id), toWarehouse: String(B._id),
    quantity: 4, date: '2026-06-10',
  }));
  assert.equal(r.journalEntryCreated, true);
  const entry = await JournalEntry.findOne({ clinic: clinicId, source: 'TRASLADO' });
  assert.equal(entry.totalDebit, 20);
  assert.equal(entry.totalCredit, 20);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.20'), 20, 'inventario destino al debe');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.10'), -20, 'inventario origen al haber');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 0, 'la caja NO se toca');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ══════════════════════ BLOQUE D · TOMAS FÍSICAS ══════════════════════

async function tomaSetup() {
  const s = await setup();
  const catInsumos = await InventoryCategory.create({ clinic: s.clinicId, code: 'INS', name: 'Insumos', kind: 'INVENTARIO' });
  const catOtros = await InventoryCategory.create({ clinic: s.clinicId, code: 'OTR', name: 'Otros', kind: 'INVENTARIO' });
  await Product.updateOne({ _id: s.prod._id }, { $set: { inventoryCategory: catInsumos._id, barcode: '7790001' } });
  const otro = await H.makeProduct(s.clinicId, { code: 'P2', name: 'Otro insumo' });
  await Product.updateOne({ _id: otro._id }, { $set: { inventoryCategory: catOtros._id } });
  const servicio = await H.makeProduct(s.clinicId, { code: 'S1', name: 'Consulta' });
  await Product.updateOne({ _id: servicio._id }, { $set: { category: 'servicio', unlimited: true } });
  return { ...s, catInsumos, catOtros, otro, servicio };
}
const iniciar = (clinicId, userId, body) => run(ctrl.startCount, H.mockReq(clinicId, userId, body));
const confirmar = (clinicId, userId, id, body = {}) => run(ctrl.confirmCount, H.mockReq(clinicId, userId, body, { params: { id: String(id) } }));

test('D1) la toma se filtra por categoría y bodega, excluye servicios y trae el stock de ESA bodega', async () => {
  const { clinicId, userId, A, B, prod, catInsumos, servicio, otro } = await tomaSetup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  await entrada(clinicId, userId, { product: prod, warehouse: B, qty: 3, cost: 5, date: d('2026-06-01') });

  const pc = ok(await iniciar(clinicId, userId, {
    warehouse: String(A._id), category: String(catInsumos._id), date: '2026-06-15',
  }));
  const ids = pc.items.map((i) => String(i.product));
  assert.ok(ids.includes(String(prod._id)));
  assert.ok(!ids.includes(String(servicio._id)), 'un servicio no se cuenta');
  assert.ok(!ids.includes(String(otro._id)), 'ni un producto de otra categoría');

  const it = pc.items[0];
  assert.equal(it.systemQty, 10, 'el stock de la bodega A, no el global (13)');
  assert.equal(it.unitCost, 5, 'y el costo REAL de sus capas, no purchasePrice');
  assert.equal(it.barcode, '7790001', 'se puede buscar por código de barras');
  assert.ok(pc.snapshotAt, 'queda congelado el snapshot');
});

test('D2) sin bodega no se puede iniciar una toma', async () => {
  const { clinicId, userId } = await tomaSetup();
  const r = await iniciar(clinicId, userId, {});
  assert.equal(r.statusCode, 400);
  assert.ok(/bodega/i.test(r.payload.message));
});

test('D3) el snapshot no cambia si después cambia la categoría del producto', async () => {
  const { clinicId, userId, A, prod, catInsumos, catOtros } = await tomaSetup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  const pc = ok(await iniciar(clinicId, userId, { warehouse: String(A._id), category: String(catInsumos._id) }));
  await Product.updateOne({ _id: prod._id }, { $set: { inventoryCategory: catOtros._id } });

  const fresca = await PhysicalCount.findById(pc._id);
  assert.equal(fresca.items.length, 1, 'la toma sigue teniendo su producto');
  assert.equal(fresca.items[0].systemQty, 10);
});

test('D4) diferencia POSITIVA: entra en la bodega correcta y el asiento cuadra', async () => {
  const { clinicId, userId, A, B, prod } = await tomaSetup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  const pc = ok(await iniciar(clinicId, userId, { warehouse: String(A._id) }));
  ok(await run(ctrl.updateCount, H.mockReq(clinicId, userId, {
    items: [{ product: String(prod._id), countedQty: 12 }],
  }, { params: { id: String(pc._id) } })));

  ok(await confirmar(clinicId, userId, pc._id, { date: '2026-06-15' }));

  const enA = await kardex.currentStock({ clinicId, product: prod._id, warehouse: A._id });
  const enB = await kardex.currentStock({ clinicId, product: prod._id, warehouse: B._id });
  const sinBodega = await InventoryLayer.countDocuments({ clinic: clinicId, warehouse: null });
  assert.equal(enA.qty, 12, 'el sobrante entra en la bodega de la toma');
  assert.equal(enB.qty, 0);
  assert.equal(sinBodega, 0, 'y NO crea capas sin bodega (era el bug)');

  const entry = await JournalEntry.findOne({ clinic: clinicId, sourceModel: 'PhysicalCount' });
  assert.equal(entry.totalDebit, 10);          // 2 × 5
  assert.equal(entry.totalCredit, 10);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 0, 'una toma física no toca la caja');
});

test('D5) diferencia NEGATIVA: consume FIFO de SU bodega y se valora al costo real', async () => {
  const { clinicId, userId, A, B, prod } = await tomaSetup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 5, cost: 4, date: d('2026-06-01') });
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 5, cost: 10, date: d('2026-06-02') });
  await entrada(clinicId, userId, { product: prod, warehouse: B, qty: 8, cost: 99, date: d('2026-06-02') });

  const pc = ok(await iniciar(clinicId, userId, { warehouse: String(A._id) }));
  ok(await run(ctrl.updateCount, H.mockReq(clinicId, userId, {
    items: [{ product: String(prod._id), countedQty: 4 }],   // faltan 6
  }, { params: { id: String(pc._id) } })));
  ok(await confirmar(clinicId, userId, pc._id, { date: '2026-06-15' }));

  const enA = await kardex.currentStock({ clinicId, product: prod._id, warehouse: A._id });
  const enB = await kardex.currentStock({ clinicId, product: prod._id, warehouse: B._id });
  assert.equal(enA.qty, 4);
  assert.equal(enB.qty, 8, 'la bodega B NO se tocó (antes el FIFO se la comía)');

  // FIFO de A: 5×4 + 1×10 = 30
  const mov = await InventoryMovement.findOne({ clinic: clinicId, sourceModel: 'PhysicalCount' });
  assert.equal(mov.totalCost, 30, 'el faltante se valora al costo REAL que sale, no al del snapshot');
  assert.equal(String(mov.warehouse), String(A._id));
  const entry = await JournalEntry.findById(mov.journalEntry);
  assert.equal(entry.totalDebit, 30, 'la merma va al gasto por su costo real');
});

test('D6) doble confirmación bloqueada y período cerrado respetado', async () => {
  const { clinicId, userId, A, prod } = await tomaSetup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  const pc = ok(await iniciar(clinicId, userId, { warehouse: String(A._id) }));
  ok(await run(ctrl.updateCount, H.mockReq(clinicId, userId, {
    items: [{ product: String(prod._id), countedQty: 11 }],
  }, { params: { id: String(pc._id) } })));

  ok(await confirmar(clinicId, userId, pc._id, { date: '2026-06-15' }));
  const otra = await confirmar(clinicId, userId, pc._id, { date: '2026-06-15' });
  assert.equal(otra.statusCode, 400);
  assert.ok(/dos veces|confirmada/i.test(otra.payload.message));
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, sourceModel: 'PhysicalCount' }), 1,
    'un solo ajuste');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'PhysicalCount' }), 1);
});

test('D7) toma sin diferencias: se cierra sin asiento (no hay hecho económico)', async () => {
  const { clinicId, userId, A, prod } = await tomaSetup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  const pc = ok(await iniciar(clinicId, userId, { warehouse: String(A._id) }));
  const r = ok(await confirmar(clinicId, userId, pc._id, { date: '2026-06-15' }));
  assert.equal(r.status, 'CONFIRMADO');
  assert.equal(r.adjustmentEntry, null);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, sourceModel: 'PhysicalCount' }), 0);
});

test('D8) dos clínicas: la toma de una no ve ni ajusta el stock de la otra', async () => {
  const a = await tomaSetup();
  const b = await tomaSetup();
  await entrada(a.clinicId, a.userId, { product: a.prod, warehouse: a.A, qty: 10, cost: 5, date: d('2026-06-01') });
  await entrada(b.clinicId, b.userId, { product: b.prod, warehouse: b.A, qty: 7, cost: 5, date: d('2026-06-01') });

  const pc = ok(await iniciar(a.clinicId, a.userId, { warehouse: String(a.A._id) }));
  assert.ok(pc.items.every((i) => String(i.product) !== String(b.prod._id)));
  ok(await run(ctrl.updateCount, H.mockReq(a.clinicId, a.userId, {
    items: [{ product: String(a.prod._id), countedQty: 8 }],
  }, { params: { id: String(pc._id) } })));
  ok(await confirmar(a.clinicId, a.userId, pc._id, { date: '2026-06-15' }));

  const enB = await kardex.currentStock({ clinicId: b.clinicId, product: b.prod._id, warehouse: b.A._id });
  assert.equal(enB.qty, 7, 'la clínica B no se movió');
});

// ══════════════════════ BLOQUE E · CENTRO DE COSTO POR BODEGA ══════════════════════

test('E1) la bodega guarda su centro de costo y lo propone a los movimientos', async () => {
  const { clinicId, userId, A, prod, B } = await setup();
  const cc = await CostCenter.create({ clinic: clinicId, code: 'CC1', name: 'Sede Norte' });
  ok(await run(ctrl.updateWarehouse, H.mockReq(clinicId, userId, { costCenter: String(cc._id) }, { params: { id: String(A._id) } })));

  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 5, cost: 4, date: d('2026-06-01') });
  ok(await run(ctrl.transferStock, H.mockReq(clinicId, userId, {
    product: String(prod._id), fromWarehouse: String(A._id), toWarehouse: String(B._id),
    quantity: 2, date: '2026-06-10',
  })));

  const salida = await InventoryMovement.findOne({ clinic: clinicId, type: 'traslado', warehouse: A._id });
  assert.equal(String(salida.costCenter), String(cc._id), 'el movimiento hereda el centro de la bodega');
  const w = await Warehouse.findById(A._id);
  assert.equal(String(w.costCenter), String(cc._id));
});

test('E2) un centro de costo de OTRA clínica se rechaza', async () => {
  const a = await setup();
  const b = await setup();
  const ccB = await CostCenter.create({ clinic: b.clinicId, code: 'CCB', name: 'De la otra clínica' });

  const r = await run(ctrl.updateWarehouse, H.mockReq(a.clinicId, a.userId,
    { costCenter: String(ccB._id) }, { params: { id: String(a.A._id) } }));
  assert.equal(r.statusCode, 400);
  assert.ok(/no existe en esta clínica/i.test(r.payload.message));
});

test('C6) el historial de traslados muestra UNA fila por traslado, no las dos patas', async () => {
  const { clinicId, userId, A, B, prod } = await setup();
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  ok(await trasladar(clinicId, userId, {
    product: String(prod._id), fromWarehouse: String(A._id), toWarehouse: String(B._id),
    quantity: 4, date: '2026-06-10',
  }));

  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, type: 'traslado' }), 2, 'dos patas');
  const lista = ok(await run(ctrl.listTransfers, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(lista.length, 1, 'pero UN traslado en el historial');
  // Cada fila es el DOCUMENTO de traslado (puede llevar varios productos), con las dos
  // bodegas en la cabecera y el detalle por producto en `items`.
  assert.equal(String(lista[0].fromWarehouse._id), String(A._id));
  assert.equal(String(lista[0].toWarehouse._id), String(B._id));
  assert.equal(lista[0].items.length, 1);
  assert.equal(String(lista[0].items[0].product._id), String(prod._id));
  assert.equal(lista[0].totalQty, 4);
});

// ══════════════════════ TAXONOMÍA DE CATEGORÍAS ══════════════════════

test('T1) un SERVICIO conserva su categoría comercial y no exige inventario', async () => {
  const { clinicId } = await setup();
  const { diagnose } = require('../scripts/diagnoseProductCategories');
  const servicio = await H.makeProduct(clinicId, { code: 'SV1', name: 'Consulta' });
  await Product.updateOne({ _id: servicio._id }, {
    // Un servicio NO lleva categoría de inventario (ni cuentas de inventario/costo).
    $set: {
      category: 'servicio', unlimited: true, categoria: 'Estética', stock: 0, inventoryCategory: null,
    },
  });

  const r = await diagnose({ clinic: clinicId });
  const fila = r.filas.find((f) => f.code === 'SV1');
  assert.equal(fila, undefined, 'un servicio con categoría comercial y sin stock está bien clasificado');
  const p = await Product.findById(servicio._id);
  assert.equal(p.categoria, 'Estética', 'y NO se le quita la categoría comercial por no tener inventario');
  assert.equal(p.inventoryCategory, null, 'ni se le exige categoría de inventario');
});

test('T2) el diagnóstico detecta servicio con inventario e inventariable sin categoría contable', async () => {
  const { clinicId, prod } = await setup();
  const { diagnose } = require('../scripts/diagnoseProductCategories');
  // (a) un servicio al que alguien le puso stock e inventario.
  const raro = await H.makeProduct(clinicId, { code: 'SV2', name: 'Servicio raro' });
  const cat = await InventoryCategory.create({ clinic: clinicId, code: 'INS', name: 'Insumos', kind: 'INVENTARIO' });
  await Product.updateOne({ _id: raro._id }, {
    $set: { category: 'servicio', unlimited: true, categoria: 'Estética', inventoryCategory: cat._id, stock: 5 },
  });
  // (b) un insumo sin categoría de inventario ni categoría comercial.
  await Product.updateOne({ _id: prod._id }, { $set: { categoria: '', inventoryCategory: null } });

  const r = await diagnose({ clinic: clinicId });
  assert.equal(r.servicioInventariable, 1);
  assert.equal(r.inventariableSinCategoria, 1);
  assert.ok(r.sinCategoriaComercial >= 1);
  const malo = r.filas.find((f) => f.code === 'SV2');
  assert.ok(malo.problemas.includes('SERVICIO_INVENTARIABLE'));
  assert.equal(malo.seguroDeCorregir, false, 'tiene stock: reclasificarlo cambiaría sus cuentas');
  // El diagnóstico NO corrige nada.
  assert.equal((await Product.findById(raro._id)).stock, 5);
});

test('T3) dos clínicas: el diagnóstico de categorías no se cruza', async () => {
  const a = await setup();
  const b = await setup();
  const { diagnose } = require('../scripts/diagnoseProductCategories');
  await Product.updateOne({ _id: a.prod._id }, { $set: { categoria: '', inventoryCategory: null } });
  await Product.updateMany({ clinic: b.clinicId }, { $set: { categoria: 'OK' } });

  const ra = await diagnose({ clinic: a.clinicId });
  const rb = await diagnose({ clinic: b.clinicId });
  assert.ok(ra.sinCategoriaComercial >= 1);
  assert.equal(rb.sinCategoriaComercial, 0, 'la clínica B no hereda los problemas de la A');
});

// ══════════════════════ DIAGNÓSTICOS HISTÓRICOS ══════════════════════

test('X1) capas sin bodega: se infieren solo cuando es demostrable, nunca a ciegas', async () => {
  const { clinicId, userId, A, B, prod } = await setup();
  const { layersWithoutWarehouse } = require('../scripts/diagnoseInventoryHistory');

  // Capa huérfana de un producto que solo vive en la bodega A → inferible (confianza MEDIA).
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 5, cost: 4, date: d('2026-06-01') });
  await kardex.receiveStock({
    clinicId, product: prod._id, warehouse: null, quantity: 2, unitCost: 4,
    date: d('2026-06-02'), sourceModel: 'PhysicalCount', sourceRef: prod._id, userId,
  });
  const r1 = await layersWithoutWarehouse({ clinic: clinicId });
  assert.equal(r1.total, 1);
  assert.equal(r1.inferibles, 1);
  assert.equal(r1.filas[0].confianza, 'MEDIA');
  assert.equal(String(r1.filas[0].bodegaInferida), String(A._id));

  // El mismo producto pasa a vivir también en B → ya NO se puede saber: AMBIGUA.
  await entrada(clinicId, userId, { product: prod, warehouse: B, qty: 1, cost: 4, date: d('2026-06-03') });
  const r2 = await layersWithoutWarehouse({ clinic: clinicId });
  assert.equal(r2.ambiguas, 1);
  assert.equal(r2.filas[0].bodegaInferida, null, 'no se adivina la bodega');
  assert.equal(r2.filas[0].corregible, false);
});

test('X2) movimientos sin fecha funcional: --commit solo completa los inequívocos', async () => {
  const { clinicId, userId, A, prod } = await setup();
  const { movementsWithoutDate } = require('../scripts/diagnoseInventoryHistory');
  const PurchaseInvoice = require('../models/PurchaseInvoice');

  const sup = await H.makeSupplier(clinicId);
  const compra = await PurchaseInvoice.create({
    clinic: clinicId, supplier: sup._id, serie: '001-001-001', fechaEmision: d('2026-05-03'),
    subtotal: 10, total: 10, balance: 10, items: [], createdBy: userId,
  });
  // (a) movimiento histórico con documento origen → fecha inequívoca.
  await InventoryMovement.create({
    clinic: clinicId, product: prod._id, type: 'entrada', warehouse: A._id, quantity: 2,
    unitCost: 5, sourceModel: 'PurchaseInvoice', sourceRef: compra._id, createdBy: userId,
  });
  // (b) movimiento histórico SIN documento → no se le inventa fecha.
  await InventoryMovement.create({
    clinic: clinicId, product: prod._id, type: 'ajuste', quantity: 1, unitCost: 5, createdBy: userId,
  });

  const seco = await movementsWithoutDate({ clinic: clinicId });
  assert.equal(seco.total, 2);
  assert.equal(seco.inequivocos, 1);
  assert.equal(seco.ambiguos, 1);
  assert.equal(seco.corregidos, 0, 'dry-run no escribe');

  const humedo = await movementsWithoutDate({ clinic: clinicId, commit: true });
  assert.equal(humedo.corregidos, 1);
  const corregido = await InventoryMovement.findOne({ clinic: clinicId, sourceModel: 'PurchaseInvoice' });
  assert.equal(corregido.dateSource, 'DOCUMENTO');
  assert.equal(new Date(corregido.movementDate).getMonth(), 4, 'la fecha de la COMPRA (mayo), no la de grabación');
  const sinDoc = await InventoryMovement.findOne({ clinic: clinicId, type: 'ajuste' });
  assert.equal(sinDoc.movementDate, null, 'el ambiguo se queda sin fecha (y el kardex lo marca)');
});

test('X3) stock global vs capas: clasifica el descuadre y NO sobrescribe Product.stock', async () => {
  const { clinicId, userId, A, prod } = await setup();
  const { stockConsistency } = require('../scripts/diagnoseInventoryHistory');
  await entrada(clinicId, userId, { product: prod, warehouse: A, qty: 10, cost: 5, date: d('2026-06-01') });
  // Alguien dejó el stock global desincronizado.
  await Product.updateOne({ _id: prod._id }, { $set: { stock: 25 } });

  const r = await stockConsistency({ clinic: clinicId });
  assert.equal(r.descuadrados, 1);
  const f = r.filas[0];
  assert.equal(f.stockGlobal, 25);
  assert.equal(f.capasQty, 10);
  assert.equal(f.diferencia, 15);
  assert.ok(f.clasificacion.startsWith('STOCK_GLOBAL_MAYOR'));
  assert.equal((await Product.findById(prod._id)).stock, 25, 'el diagnóstico NO corrige nada');
});

test('E3) un centro de costo INACTIVO se rechaza', async () => {
  const { clinicId, userId, A } = await setup();
  const cc = await CostCenter.create({ clinic: clinicId, code: 'CC0', name: 'Viejo', active: false });
  const r = await run(ctrl.updateWarehouse, H.mockReq(clinicId, userId,
    { costCenter: String(cc._id) }, { params: { id: String(A._id) } }));
  assert.equal(r.statusCode, 400);
  assert.ok(/inactivo/i.test(r.payload.message));
});
