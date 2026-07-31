/**
 * Verificación end-to-end de los cambios de este lote (conciliación por corte,
 * reportes jerárquicos, sugerencia de cuenta hija, bodegas e import TXT) contra
 * los controllers reales y Mongo en memoria.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const bank = require('../controllers/bankController');
const reports = require('../controllers/accountingReportsController');
const chart = require('../controllers/chartOfAccountController');
const product = require('../controllers/productController');
const invAdv = require('../controllers/inventoryAdvancedController');
const purchase = require('../controllers/purchaseInvoiceController');
const sale = require('../controllers/saleController');

const BankAccount = require('../models/BankAccount');
const BankTransaction = require('../models/BankTransaction');
const ChartOfAccount = require('../models/ChartOfAccount');
const Warehouse = require('../models/Warehouse');
const Product = require('../models/Product');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function makeBank(clinicId) {
  const acc = await ChartOfAccount.findOne({ clinic: clinicId, code: /^1\.1\.01/, allowsMovement: true });
  return BankAccount.create({ clinic: clinicId, name: 'Banco X', bank: 'Pichincha', accountNumber: '123456', chartAccount: acc._id, initialBalance: 0 });
}
function makeTx(clinicId, bankId, { amount, direction, date, reference = '' }) {
  return BankTransaction.create({ clinic: clinicId, bankAccount: bankId, date, type: direction > 0 ? 'DEPOSITO' : 'RETIRO', amount, direction, reference });
}

// ─────────────────────────────────────────────────────────────────────────────
test('Conciliación por corte: trae movimientos <= corte poblados, import empareja y cierre concilia', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const b = await makeBank(clinicId);
  const t1 = await makeTx(clinicId, b._id, { amount: 100, direction: 1, date: new Date('2026-02-10'), reference: 'DEP1' });
  await makeTx(clinicId, b._id, { amount: 30, direction: -1, date: new Date('2026-02-15'), reference: 'COM1' });
  await makeTx(clinicId, b._id, { amount: 999, direction: 1, date: new Date('2026-03-05') }); // posterior al corte

  const started = await H.runController(bank.startReconciliation, H.mockReq(clinicId, userId, {
    bankAccount: b._id, cutDate: '2026-02-28', statementBalance: 70, description: 'Feb 2026',
  }));
  assert.equal(started.statusCode, 201, JSON.stringify(started.payload));
  const rec = started.payload;
  assert.equal(rec.status, 'BORRADOR');
  assert.equal(rec.items.length, 2, 'solo los <= corte');
  assert.equal(rec.items[0].transaction.amount, 100, 'items poblados con la transacción');
  assert.equal(rec.bookBalance, 70, '100 - 30');
  assert.equal(rec.difference, 0);

  const imp = await H.runController(bank.reconcileImport, H.mockReq(clinicId, userId,
    { lines: [{ date: '2026-02-10', reference: 'DEP1', amount: 100 }, { date: '2026-02-15', reference: 'COM1', amount: -30 }] },
    { params: { id: String(rec._id) } }));
  assert.equal(imp.statusCode, 200, JSON.stringify(imp.payload));
  assert.equal(imp.payload.matched, 2, 'las 2 líneas emparejan');
  assert.equal(imp.payload.reconciliation.items.filter((i) => i.matched).length, 2);

  const closed = await H.runController(bank.closeReconciliation, H.mockReq(clinicId, userId, {}, { params: { id: String(rec._id) } }));
  assert.equal(closed.statusCode, 200, JSON.stringify(closed.payload));
  assert.equal(closed.payload.status, 'CONCILIADO');
  assert.equal((await BankTransaction.findById(t1._id)).reconciled, true, 'la transacción emparejada queda conciliada');
});

// ─────────────────────────────────────────────────────────────────────────────
test('Reportes: estado de resultados con árbol + cascada y balance con árbol que cuadra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40, stock: 0 });
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(),
    items: [{ description: 'Insumo', product: prod._id, quantity: 10, unitPrice: 40, ivaRate: 15, subtotal: 400 }],
  }));
  await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 2, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));

  const is = await H.runController(reports.incomeStatement, H.mockReq(clinicId, userId, {}, { query: {} }));
  assert.equal(is.statusCode, 200, JSON.stringify(is.payload));
  assert.ok(Array.isArray(is.payload.tree), 'devuelve árbol jerárquico');
  assert.ok(is.payload.totalIngresos > 0, 'hay ingresos');
  assert.equal(typeof is.payload.participacionTrabajadores, 'number');
  assert.equal(typeof is.payload.impuestoRenta, 'number');
  assert.equal(typeof is.payload.utilidadNeta, 'number');

  const bs = await H.runController(reports.balanceSheet, H.mockReq(clinicId, userId, {}, { query: {} }));
  assert.equal(bs.statusCode, 200, JSON.stringify(bs.payload));
  assert.ok(bs.payload.tree && Array.isArray(bs.payload.tree.activos), 'balance con árbol de activos');
  assert.ok(Math.abs(bs.payload.descuadre) <= 0.01, `el balance debe cuadrar (descuadre ${bs.payload.descuadre})`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('Plan de cuentas: sugiere código/nivel/tipo de la cuenta hija desde el padre', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const parent = await ChartOfAccount.findOne({ clinic: clinicId, code: /^\d+\.\d+$/ }).sort({ code: 1 });
  assert.ok(parent, 'existe alguna cuenta de nivel 2 en el seed');
  const r = await H.runController(chart.suggestChild, H.mockReq(clinicId, userId, {}, { query: { parent: String(parent._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.ok(r.payload.code.startsWith(parent.code + '.'), `código hijo bajo el padre (${r.payload.code})`);
  assert.equal(r.payload.level, parent.level + 1);
  assert.equal(r.payload.type, parent.type);
});

// ─────────────────────────────────────────────────────────────────────────────
test('Bodegas: movimiento con bodega crea capa y el traslado mueve stock entre bodegas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await H.makeProduct(clinicId, { category: 'insumo', purchasePrice: 5, stock: 0 });
  const w1 = await Warehouse.create({ clinic: clinicId, code: 'B1', name: 'Bodega 1', isMain: true });
  const w2 = await Warehouse.create({ clinic: clinicId, code: 'B2', name: 'Bodega 2' });

  const mv = await H.runController(product.createMovement, H.mockReq(clinicId, userId, {
    product: prod._id, type: 'entrada', quantity: 10, warehouse: String(w1._id),
  }));
  assert.equal(mv.statusCode, 201, JSON.stringify(mv.payload));
  assert.equal((await Product.findById(prod._id)).stock, 10);

  const tr = await H.runController(invAdv.transferStock, H.mockReq(clinicId, userId, {
    product: prod._id, fromWarehouse: String(w1._id), toWarehouse: String(w2._id), quantity: 4,
  }));
  assert.equal(tr.statusCode, 201, JSON.stringify(tr.payload));

  const ws = await H.runController(invAdv.warehouseStock, H.mockReq(clinicId, userId, {}, { query: {} }));
  const row = ws.payload.find((r) => String(r.product._id) === String(prod._id));
  assert.ok(row, 'el producto aparece en existencias por bodega');
  assert.equal(row.totalQty, 10, 'el traslado no cambia el total');
  const byWh = Object.fromEntries(row.warehouses.map((w) => [w.warehouse?.name, w.qty]));
  assert.equal(byWh['Bodega 1'], 6);
  assert.equal(byWh['Bodega 2'], 4);
});

// ─────────────────────────────────────────────────────────────────────────────
test('Compras: importar TXT (pipe) crea la factura del proveedor', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Fecha de HOY: el importador rechaza comprobantes atrasados (utils/fiscalDocumentDate).
  const hoy = H.docDate();
  const f = `${String(hoy.getDate()).padStart(2, '0')}/${String(hoy.getMonth() + 1).padStart(2, '0')}/${hoy.getFullYear()}`;
  const txt = `0999999999001|Proveedor Uno|FACTURA|001-001-000000123|AUTH123|${f}|100.00|15.00|115.00`;
  const r = await H.runController(purchase.importTxt, H.mockReq(clinicId, userId, { text: txt }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.created, 1, JSON.stringify(r.payload));
  assert.equal(r.payload.errors.length, 0);
});
