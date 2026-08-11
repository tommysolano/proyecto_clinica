/**
 * TRASLADO DE VARIOS PRODUCTOS ENTRE BODEGAS.
 *
 * Un traslado es un DOCUMENTO: se eligen las dos bodegas una vez y se mueven todos los
 * productos que haga falta. Lo que se comprueba aquí es que sigue siendo UNA operación —
 * mismo `transferGroup`, un solo asiento y todo o nada si falta stock en una línea— y que
 * el historial lo muestra agrupado con su fecha.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ctrl = require('../controllers/inventoryAdvancedController');
const productCtrl = require('../controllers/productController');
const InventoryMovement = require('../models/InventoryMovement');
const JournalEntry = require('../models/JournalEntry');
const Warehouse = require('../models/Warehouse');
const ChartOfAccount = require('../models/ChartOfAccount');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r, msg) => { assert.equal(r.statusCode < 400, true, msg || JSON.stringify(r.payload)); return r.payload; };

/** Dos bodegas con CUENTAS DISTINTAS (para que el traslado genere asiento) y dos productos. */
async function setup() {
  const { clinicId, userId } = await H.seedClinic();
  // Cuentas de DETALLE del plan por defecto (las de nivel superior no admiten movimientos).
  const invA = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.04.01' });
  const invB = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.04.02' });
  const A = await Warehouse.create({ clinic: clinicId, code: 'B1', name: 'Bodega 1', chartAccount: invA._id, isMain: true });
  const B = await Warehouse.create({ clinic: clinicId, code: 'B2', name: 'Bodega 2', chartAccount: invB._id });
  const p1 = await H.makeProduct(clinicId, { name: 'Gasas', code: 'P1', category: 'insumo', purchasePrice: 5 });
  const p2 = await H.makeProduct(clinicId, { name: 'Jeringas', code: 'P2', category: 'insumo', purchasePrice: 2 });
  return { clinicId, userId, A, B, p1, p2 };
}

/** Entrada manual de stock en una bodega. */
const entrada = (clinicId, userId, product, warehouse, quantity, unitCost) => H.runController(
  productCtrl.createMovement,
  H.mockReq(clinicId, userId, { product: String(product._id), type: 'entrada', quantity, unitCost, warehouse: String(warehouse._id) })
);

const trasladar = (clinicId, userId, body) => H.runController(ctrl.transferStock, H.mockReq(clinicId, userId, body));

// ─────────────────────────────────────────────────────────────────────────────
test('mueve VARIOS productos en un solo traslado, con un solo asiento', async () => {
  const { clinicId, userId, A, B, p1, p2 } = await setup();
  ok(await entrada(clinicId, userId, p1, A, 10, 5));
  ok(await entrada(clinicId, userId, p2, A, 20, 2));

  const r = await trasladar(clinicId, userId, {
    fromWarehouse: String(A._id), toWarehouse: String(B._id),
    date: '2026-08-05', reason: 'Reposición de farmacia',
    items: [
      { product: String(p1._id), quantity: 4 },
      { product: String(p2._id), quantity: 6 },
    ],
  });
  const payload = ok(r);

  assert.equal(payload.lines, 2, 'el traslado tiene dos líneas');
  assert.equal(payload.totalCost, 32, '4×5 + 6×2 al costo de las capas');
  assert.equal(payload.journalEntryCreated, true, 'las bodegas tienen cuentas distintas');

  // Un solo documento: las cuatro patas (2 salidas + 2 entradas) comparten transferGroup.
  const movs = await InventoryMovement.find({ clinic: clinicId, type: 'traslado' });
  assert.equal(movs.length, 4);
  assert.equal(new Set(movs.map((m) => String(m.transferGroup))).size, 1, 'un único grupo de traslado');

  // Un solo asiento por el costo total, no uno por producto.
  const asientos = await JournalEntry.find({ clinic: clinicId, source: 'TRASLADO' });
  assert.equal(asientos.length, 1);
  const total = asientos[0].lines.reduce((s, l) => s + Number(l.debit || 0), 0);
  assert.equal(total, 32);

  // Existencias: lo que salió de A está en B, el total no cambia.
  const stock = ok(await H.runController(ctrl.warehouseStock, H.mockReq(clinicId, userId, {}, { query: {} })));
  const porBodega = (prodId) => Object.fromEntries(
    stock.find((s) => String(s.product._id) === String(prodId)).warehouses.map((w) => [w.warehouse?.name, w.qty])
  );
  assert.deepEqual(porBodega(p1._id), { 'Bodega 1': 6, 'Bodega 2': 4 });
  assert.deepEqual(porBodega(p2._id), { 'Bodega 1': 14, 'Bodega 2': 6 });
});

test('si a UNA línea le falta stock no se mueve NADA', async () => {
  const { clinicId, userId, A, B, p1, p2 } = await setup();
  ok(await entrada(clinicId, userId, p1, A, 10, 5));
  ok(await entrada(clinicId, userId, p2, A, 3, 2));

  const r = await trasladar(clinicId, userId, {
    fromWarehouse: String(A._id), toWarehouse: String(B._id),
    items: [
      { product: String(p1._id), quantity: 4 },   // esta sí se puede
      { product: String(p2._id), quantity: 99 },  // esta no
    ],
  });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /Jeringas/, 'dice qué producto falló');
  assert.match(r.payload.message, /Bodega 1/, 'y en qué bodega');
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, type: 'traslado' }), 0, 'ni el producto que sí alcanzaba se movió');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'TRASLADO' }), 0);

  const stock = ok(await H.runController(ctrl.warehouseStock, H.mockReq(clinicId, userId, {}, { query: {} })));
  const enB = stock.flatMap((s) => s.warehouses).filter((w) => w.warehouse?.name === 'Bodega 2');
  assert.equal(enB.length, 0, 'la bodega destino sigue vacía');
});

test('rechaza el mismo producto repetido en dos líneas', async () => {
  const { clinicId, userId, A, B, p1 } = await setup();
  ok(await entrada(clinicId, userId, p1, A, 10, 5));

  const r = await trasladar(clinicId, userId, {
    fromWarehouse: String(A._id), toWarehouse: String(B._id),
    items: [{ product: String(p1._id), quantity: 2 }, { product: String(p1._id), quantity: 3 }],
  });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /repetido/i);
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, type: 'traslado' }), 0);
});

test('la forma antigua de un solo producto sigue funcionando', async () => {
  const { clinicId, userId, A, B, p1 } = await setup();
  ok(await entrada(clinicId, userId, p1, A, 10, 5));

  const payload = ok(await trasladar(clinicId, userId, {
    product: String(p1._id), fromWarehouse: String(A._id), toWarehouse: String(B._id), quantity: 4,
  }));

  assert.equal(payload.lines, 1);
  assert.equal(payload.quantity, 4, 'sigue devolviendo el movimiento suelto');
  assert.equal(await InventoryMovement.countDocuments({ clinic: clinicId, type: 'traslado' }), 2);
});

test('el historial agrupa el traslado en una fila con su fecha y sus productos', async () => {
  const { clinicId, userId, A, B, p1, p2 } = await setup();
  ok(await entrada(clinicId, userId, p1, A, 10, 5));
  ok(await entrada(clinicId, userId, p2, A, 20, 2));
  ok(await trasladar(clinicId, userId, {
    fromWarehouse: String(A._id), toWarehouse: String(B._id), date: '2026-08-05',
    items: [{ product: String(p1._id), quantity: 4 }, { product: String(p2._id), quantity: 6 }],
  }));

  const lista = ok(await H.runController(ctrl.listTransfers, H.mockReq(clinicId, userId, {}, { query: {} })));
  assert.equal(lista.length, 1, 'un traslado = una fila, aunque lleve dos productos');
  const t = lista[0];
  assert.equal(t.fromWarehouse.name, 'Bodega 1');
  assert.equal(t.toWarehouse.name, 'Bodega 2');
  assert.equal(t.items.length, 2);
  assert.equal(t.totalQty, 10);
  assert.equal(t.totalCost, 32);
  assert.equal(new Date(t.date).getUTCFullYear(), 2026);
  // Queda registrado QUIÉN lo hizo (aquí el usuario es solo un id sembrado, sin ficha
  // que poblar, así que se comprueba la referencia en el movimiento).
  const salida = await InventoryMovement.findById(t.items[0].movementId);
  assert.equal(String(salida.createdBy), String(userId));

  // Filtro por bodega: aparece tanto buscando por el origen como por el destino.
  const porOrigen = ok(await H.runController(ctrl.listTransfers, H.mockReq(clinicId, userId, {}, { query: { warehouse: String(A._id) } })));
  assert.equal(porOrigen.length, 1);
  const porDestino = ok(await H.runController(ctrl.listTransfers, H.mockReq(clinicId, userId, {}, { query: { warehouse: String(B._id) } })));
  assert.equal(porDestino.length, 1);

  // Filtro por texto libre sobre el producto.
  const buscando = ok(await H.runController(ctrl.listTransfers, H.mockReq(clinicId, userId, {}, { query: { q: 'jeringa' } })));
  assert.equal(buscando.length, 1);
  const sinResultados = ok(await H.runController(ctrl.listTransfers, H.mockReq(clinicId, userId, {}, { query: { q: 'no existe' } })));
  assert.equal(sinResultados.length, 0);

  // Filtro por fechas: fuera del rango no sale.
  const fuera = ok(await H.runController(ctrl.listTransfers, H.mockReq(clinicId, userId, {}, { query: { from: '2026-09-01' } })));
  assert.equal(fuera.length, 0);
  const dentro = ok(await H.runController(ctrl.listTransfers, H.mockReq(clinicId, userId, {}, { query: { from: '2026-08-01', to: '2026-08-31' } })));
  assert.equal(dentro.length, 1);
});
