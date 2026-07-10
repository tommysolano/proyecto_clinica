/**
 * Asiento de costo de venta (revisión del contador).
 * Al facturar un producto de inventario, el asiento de la venta debe tener:
 *   Débito caja/banco/CxC · Crédito ingreso por ventas · Crédito IVA ventas
 *   Débito costo de venta · Crédito inventario (valorado por kardex FIFO)
 * y las cuentas de ingreso/costo/inventario deben salir de la CATEGORÍA CONTABLE
 * del producto (misma fuente que usan las compras), no del rol genérico.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const sale = require('../controllers/saleController');
const purchase = require('../controllers/purchaseInvoiceController');
const ChartOfAccount = require('../models/ChartOfAccount');
const InventoryCategory = require('../models/InventoryCategory');
const JournalEntry = require('../models/JournalEntry');
const Product = require('../models/Product');
const Sale = require('../models/Sale');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Categoría contable con cuentas PROPIAS (distintas de los roles por defecto). */
async function customCategory(clinicId) {
  const mk = (code, name, type, nature) => ChartOfAccount.create({ clinic: clinicId, code, name, type, nature, allowsMovement: true });
  const inv = await mk('1.1.04.77', 'Inventario medicamentos', 'ACTIVO', 'DEBITO');
  const cost = await mk('5.1.77', 'Costo medicamentos', 'COSTO', 'DEBITO');
  const inc = await mk('4.1.77', 'Venta de medicamentos', 'INGRESO', 'CREDITO');
  const cat = await InventoryCategory.create({
    clinic: clinicId, code: 'MED', name: 'Medicamentos', kind: 'INVENTARIO',
    assetAccount: inv._id, expenseAccount: cost._id, incomeAccount: inc._id,
  });
  return { cat, inv, cost, inc };
}

// ─────────────────────────────────────────────────────────────────────────────
test('venta de producto: asiento venta+costo con las cuentas de la CATEGORÍA del producto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { cat } = await customCategory(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40, stock: 0, inventoryCategory: cat._id });
  const sup = await H.makeSupplier(clinicId);

  // Compra 10 @ 40: crea la capa FIFO y debita el inventario de la categoría (1.1.04.77 = 400).
  const pr = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(),
    items: [{ description: 'Med', product: prod._id, quantity: 10, unitPrice: 40, ivaRate: 15, subtotal: 400 }],
  }));
  assert.equal(pr.statusCode, 201, JSON.stringify(pr.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.77'), 400, 'la compra entra al inventario de la categoría');

  // Venta de contado: 2 @ 115 (IVA incluido) → base 200, IVA 30, COGS 2x40=80.
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 2, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  // Efectos en el mayor: TODAS las cuentas salen de la categoría del producto.
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 230, 'caja al debe por el total');
  assert.equal(await H.accountBalanceByCode(clinicId, '4.1.77'), -200, 'ingreso por venta de la CATEGORÍA');
  assert.equal(await H.accountBalanceByCode(clinicId, '4.1.02'), 0, 'NO usa el ingreso genérico');
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.77'), 80, 'costo de venta de la CATEGORÍA (kardex 2x40)');
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.01'), 0, 'NO usa el costo genérico');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.77'), 320, 'inventario de la categoría baja 80 (400-80)');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 0, 'NO toca el inventario genérico');

  // Stock descontado y mayor cuadrado.
  assert.equal((await Product.findById(prod._id)).stock, 8);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);

  // Visible desde la factura: la venta guarda su asiento y éste contiene las 2 líneas de costo.
  const s = await Sale.findById(r.payload._id);
  assert.ok(s.journalEntry, 'la venta referencia su asiento');
  const entry = await JournalEntry.findById(s.journalEntry);
  const costLine = entry.lines.find((l) => /Costo venta/.test(l.description));
  const invLine = entry.lines.find((l) => /Salida inventario/.test(l.description));
  const ivaLine = entry.lines.find((l) => /IVA en ventas/.test(l.description));
  assert.ok(costLine && costLine.debit === 80, 'Débito: costo de venta 80');
  assert.ok(invLine && invLine.credit === 80, 'Crédito: inventario 80');
  assert.ok(ivaLine && ivaLine.credit === 30, 'Crédito: IVA ventas 30');
});

// ─────────────────────────────────────────────────────────────────────────────
test('venta FIFO multicapa con categoría propia: COGS pondera capas y sale de la cuenta de la categoría', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { cat } = await customCategory(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, stock: 0, inventoryCategory: cat._id });
  const sup = await H.makeSupplier(clinicId);
  // Capa 1: 5 @ 10 · Capa 2: 5 @ 20
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-01'), serie: '001-001-000000201',
    items: [{ description: 'M', product: prod._id, quantity: 5, unitPrice: 10, ivaRate: 15, subtotal: 50 }],
  }));
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-10'), serie: '001-001-000000202',
    items: [{ description: 'M', product: prod._id, quantity: 5, unitPrice: 20, ivaRate: 15, subtotal: 100 }],
  }));
  // Vende 7: FIFO consume 5@10 + 2@20 = 90 de costo.
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 7, unitPrice: 115 }], paymentMethod: 'efectivo', date: new Date('2026-06-15'),
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.77'), 90, 'COGS FIFO ponderado en la cuenta de la categoría');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.77'), 60, 'inventario categoría: 150 comprado - 90 vendido');
  assert.equal((await Product.findById(prod._id)).stock, 3);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('producto SIN categoría (legacy) sigue cayendo al rol genérico (no rompe ventas viejas)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Producto legacy sin categoría contable y sin capas: vende con costo promedio de respaldo.
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40, stock: 5, averageCost: 40, inventoryCategory: null });
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 1, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, '4.1.02'), -100, 'ingreso genérico');
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.01'), 40, 'costo genérico (promedio de respaldo)');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});
