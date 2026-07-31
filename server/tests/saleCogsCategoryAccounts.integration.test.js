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
const journal = require('../controllers/journalEntryController');
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

  // DOS asientos por venta (contadora): el de la venta (ingreso+IVA) y el del costo (COGS+inventario).
  const s = await Sale.findById(r.payload._id);
  assert.ok(s.journalEntry, 'la venta referencia su asiento de venta');
  assert.ok(s.costJournalEntry, 'la venta referencia su asiento de costo (separado)');
  assert.notEqual(String(s.journalEntry), String(s.costJournalEntry), 'son dos asientos distintos');
  const ventaEntry = await JournalEntry.findById(s.journalEntry);
  const costEntry = await JournalEntry.findById(s.costJournalEntry);
  // Asiento de VENTA: IVA en ventas al haber; NO contiene el costo de venta.
  const ivaLine = ventaEntry.lines.find((l) => /IVA en ventas/.test(l.description));
  assert.ok(ivaLine && ivaLine.credit === 30, 'Asiento venta: IVA ventas 30 al haber');
  assert.ok(!ventaEntry.lines.some((l) => /Costo venta/.test(l.description)), 'el costo NO va en el asiento de venta');
  assert.ok(ventaEntry.sourceAction === 'POST' && costEntry.sourceAction === 'POST_COST', 'sourceActions distinguibles');
  // Asiento de COSTO: débito costo de venta / crédito inventario, valorado por kardex.
  const costLine = costEntry.lines.find((l) => /Costo venta/.test(l.description));
  const invLine = costEntry.lines.find((l) => /Salida inventario/.test(l.description));
  assert.ok(costLine && costLine.debit === 80, 'Asiento costo: costo de venta 80 al debe');
  assert.ok(invLine && invLine.credit === 80, 'Asiento costo: inventario 80 al haber');
  assert.ok(Math.abs(costEntry.totalDebit - costEntry.totalCredit) < 0.01, 'asiento de costo cuadrado');
});

// ─────────────────────────────────────────────────────────────────────────────
test('venta FIFO multicapa con categoría propia: COGS pondera capas y sale de la cuenta de la categoría', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { cat } = await customCategory(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, stock: 0, inventoryCategory: cat._id });
  const sup = await H.makeSupplier(clinicId);
  // Capa 1: 5 @ 10 · Capa 2: 5 @ 20
  // Las fechas son relativas a HOY (los comprobantes no admiten fecha atrasada); lo que
  // importa aquí es el ORDEN de las capas, no el mes del calendario.
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(0), serie: '001-001-000000201',
    items: [{ description: 'M', product: prod._id, quantity: 5, unitPrice: 10, ivaRate: 15, subtotal: 50 }],
  }));
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: H.docDate(1), serie: '001-001-000000202',
    items: [{ description: 'M', product: prod._id, quantity: 5, unitPrice: 20, ivaRate: 15, subtotal: 100 }],
  }));
  // Vende 7: FIFO consume 5@10 + 2@20 = 90 de costo.
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 7, unitPrice: 115 }], paymentMethod: 'efectivo', date: H.docDate(2),
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.77'), 90, 'COGS FIFO ponderado en la cuenta de la categoría');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.77'), 60, 'inventario categoría: 150 comprado - 90 vendido');
  assert.equal((await Product.findById(prod._id)).stock, 3);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('producto SIN categoría con costo se BLOQUEA (regla nueva: sin categoría no se contabiliza el costo)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Producto sin categoría contable con stock: al vender, el costo NO tiene de dónde salir → bloqueo.
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40, stock: 5, averageCost: 40, inventoryCategory: null });
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 1, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /categoría de inventario/i);
  // Nada contabilizado a medias: ni ingreso ni costo, y el stock intacto.
  assert.equal(await H.accountBalanceByCode(clinicId, '4.1.02'), 0, 'no debe registrar ingreso');
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.01'), 0, 'no debe registrar costo');
  assert.equal((await require('../models/Product').findById(prod._id)).stock, 5, 'stock intacto (rollback)');
});

// ─────────────────────────────────────────────────────────────────────────────
test('producto SIN categoría cuya categoría no tiene cuenta de costo se BLOQUEA nombrando la categoría', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Categoría con inventario pero SIN cuenta de costo.
  const inv = await ChartOfAccount.create({ clinic: clinicId, code: '1.1.04.88', name: 'Inv X', type: 'ACTIVO', nature: 'DEBITO', allowsMovement: true });
  const cat = await InventoryCategory.create({ clinic: clinicId, code: 'SINCOSTO', name: 'Sin costo', kind: 'INVENTARIO', assetAccount: inv._id });
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40, stock: 5, averageCost: 40, inventoryCategory: cat._id });
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 1, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /Sin costo/, 'el mensaje nombra la categoría');
  assert.match(r.payload.message, /cuenta de costo/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('venta de SOLO servicio con categoría SERVICIO: un solo asiento, ingreso en la cuenta de la categoría', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Cuenta de ingreso PROPIA de la categoría de servicio (distinta del rol genérico 4.1.01).
  const incSvc = await ChartOfAccount.create({ clinic: clinicId, code: '4.1.55', name: 'Ingreso consultas', type: 'INGRESO', nature: 'CREDITO', allowsMovement: true });
  const catSvc = await InventoryCategory.create({ clinic: clinicId, code: 'SVC', name: 'Consultas', kind: 'SERVICIO', incomeAccount: incSvc._id });
  const serv = await H.makeProduct(clinicId, { category: 'servicio', unlimited: true, salePrice: 50, inventoryCategory: catSvc._id });

  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 50 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const s = await Sale.findById(r.payload._id);
  assert.ok(s.journalEntry, 'asiento de venta');
  assert.equal(s.costJournalEntry, null, 'un servicio NO genera asiento de costo');
  // El ingreso va a la cuenta de la CATEGORÍA (4.1.55), no al rol genérico de servicios (4.1.01).
  assert.ok((await H.accountBalanceByCode(clinicId, '4.1.55')) < 0, 'ingreso en la cuenta de la categoría de servicio');
  assert.equal(await H.accountBalanceByCode(clinicId, '4.1.01'), 0, 'NO usa el ingreso genérico de servicios');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  // Sin categoría con incomeAccount, un servicio cae al genérico pero AVISA (no bloquea).
  const serv2 = await H.makeProduct(clinicId, { category: 'servicio', unlimited: true, salePrice: 30, inventoryCategory: null });
  const r2 = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv2._id, quantity: 1, unitPrice: 30 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r2.statusCode, 201, JSON.stringify(r2.payload));
  assert.ok(Array.isArray(r2.payload.warnings) && r2.payload.warnings.length >= 1, 'avisa que conviene categorizar el servicio');
  assert.ok((await H.accountBalanceByCode(clinicId, '4.1.01')) < 0, 'servicio sin categoría usa el ingreso genérico de servicios');
});

// ─────────────────────────────────────────────────────────────────────────────
test('anular una venta reversa AMBOS asientos (venta y costo)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { cat } = await customCategory(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40, stock: 0, inventoryCategory: cat._id });
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(), items: [{ description: 'Med', product: prod._id, quantity: 10, unitPrice: 40, ivaRate: 15, subtotal: 400 }],
  }));
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 2, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const s = await Sale.findById(r.payload._id);
  assert.ok(s.journalEntry && s.costJournalEntry);

  const cancel = await H.runController(sale.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: String(s._id) } }));
  assert.equal(cancel.statusCode, 200, JSON.stringify(cancel.payload));
  // Los DOS asientos originales quedan reversados (rastro de auditoría), no borrados.
  const venta = await JournalEntry.findById(s.journalEntry);
  const costo = await JournalEntry.findById(s.costJournalEntry);
  assert.equal(venta.isReversed, true, 'el asiento de venta quedó reversado');
  assert.equal(costo.isReversed, true, 'el asiento de costo quedó reversado');
  // Efecto neto en el mayor: cero en costo (5.1.77) e inventario vuelve a 400.
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.77'), 0, 'costo neto 0 tras anular');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.77'), 400, 'inventario vuelve a 400');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
  assert.equal((await Sale.findById(s._id)).status, 'anulada');
});

// ─────────────────────────────────────────────────────────────────────────────
test('by-source (visor Kardex/documento): trae AMBOS asientos (venta + COSTO) y el asiento no se puede editar', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const { cat } = await customCategory(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40, stock: 0, inventoryCategory: cat._id });
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(), items: [{ description: 'Med', product: prod._id, quantity: 10, unitPrice: 40, ivaRate: 15, subtotal: 400 }],
  }));
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 2, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const s = await Sale.findById(r.payload._id);

  // by-source devuelve los DOS asientos del documento (venta + costo), ambos vigentes.
  let bs = await H.runController(journal.bySource, H.mockReq(clinicId, userId, {}, { query: { model: 'Sale', ref: String(s._id) } }));
  assert.equal(bs.statusCode, 200);
  assert.equal(bs.payload.length, 2, 'venta + costo');
  assert.ok(bs.payload.every((e) => !e.isReversed), 'ambos vigentes');
  assert.ok(bs.payload.some((e) => e.sourceAction === 'POST') && bs.payload.some((e) => e.sourceAction === 'POST_COST'));

  // El visor trae el asiento de COSTO junto al de venta: el costo se ve en el modal del
  // asiento, sin tener que ir a los reportes.
  const costEntry = bs.payload.find((e) => e.sourceAction === 'POST_COST');
  assert.ok(costEntry.lines.some((l) => l.accountCode === '5.1.77' && l.debit > 0), 'el asiento de costo trae la cuenta de costo de ventas');
  assert.ok(costEntry.lines.some((l) => l.accountCode === '1.1.04.77' && l.credit > 0), 'el asiento de costo acredita inventario');

  // Un asiento contabilizado es INMUTABLE: no existe endpoint para reescribirlo a mano.
  assert.equal(typeof sale.editJournalSale, 'undefined', 'no debe existir edición manual del asiento de venta');
  assert.equal(typeof purchase.editJournal, 'undefined', 'no debe existir edición manual del asiento de compra');

  // La única vía de corrección es ANULAR: los originales quedan reversados (auditoría) y
  // aparecen las reversas; nunca se sobrescribe un asiento.
  const cancel = await H.runController(sale.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: String(s._id) } }));
  assert.equal(cancel.statusCode, 200, JSON.stringify(cancel.payload));
  bs = await H.runController(journal.bySource, H.mockReq(clinicId, userId, {}, { query: { model: 'Sale', ref: String(s._id) } }));
  assert.equal(bs.payload.filter((e) => e.isReversed).length, 2, 'venta y costo quedan reversados y visibles');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});
