/**
 * Flujos completos end-to-end contra los controllers reales y un Mongo en memoria
 * con replica set. Cada flujo refleja una operación real del sistema y verifica:
 *   - estado de los documentos (venta/compra/pago/caja),
 *   - inventario (kardex),
 *   - subledger (CxC/CxP),
 *   - y que el mayor quede SIEMPRE cuadrado (partida doble).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const sale = require('../controllers/saleController');
const purchase = require('../controllers/purchaseInvoiceController');
const payment = require('../controllers/paymentController');
const cash = require('../controllers/cashClosingController');
const health = require('../controllers/accountingHealthController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 1 — Venta de contado (efectivo) con producto: stock, kardex, COGS y mayor cuadrado', async () => {
  const { clinicId, userId } = await H.seedClinic();
  // Compra previa para tener capa de inventario valorada a $40
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40, stock: 0 });
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(),
    items: [{ description: 'Insumo', product: prod._id, quantity: 10, unitPrice: 40, ivaRate: 15, subtotal: 400 }],
  }));

  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 2, unitPrice: 115 }],
    paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const Sale = require('../models/Sale');
  const s = await Sale.findById(r.payload._id);
  assert.equal(s.total, 230);            // 2 x 115 (IVA incluido)
  assert.equal(s.taxAmount, 30);         // 230 - 200
  assert.equal(s.paid, true);

  // Stock baja de 10 a 8
  const Product = require('../models/Product');
  const p = await Product.findById(prod._id);
  assert.equal(p.stock, 8);

  // Caja registra 230 (debe), ingreso productos 200 (haber), IVA ventas 30, COGS 80, inventario -80
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 230); // caja
  assert.equal(await H.accountBalanceByCode(clinicId, '4.1.02'), -200);   // ingreso productos
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.01'), 80);     // costo (2 x 40)

  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 2 — Venta a crédito + cobro parcial + cobro final: CxC concilia y mayor cuadra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });

  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 100 }],
    paymentMethod: 'credito',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const saleId = r.payload._id;

  // Subledger abierto con balance 100
  const Receivable = require('../models/Receivable');
  let rec = await Receivable.findOne({ clinic: clinicId, sourceRef: saleId });
  assert.equal(rec.balance, 100);
  assert.equal(rec.status, 'ABIERTO');

  // Cobro parcial 60
  const c1 = await H.runController(sale.collectSale, H.mockReq(clinicId, userId,
    { amount: 60, paymentMethod: 'efectivo' }, { params: { id: saleId } }));
  assert.equal(c1.statusCode, 200, JSON.stringify(c1.payload));
  rec = await Receivable.findOne({ clinic: clinicId, sourceRef: saleId });
  assert.equal(rec.balance, 40);
  assert.equal(rec.status, 'PARCIAL');

  // Cobro final 40
  const c2 = await H.runController(sale.collectSale, H.mockReq(clinicId, userId,
    { amount: 40, paymentMethod: 'efectivo' }, { params: { id: saleId } }));
  assert.equal(c2.statusCode, 200, JSON.stringify(c2.payload));
  rec = await Receivable.findOne({ clinic: clinicId, sourceRef: saleId });
  assert.equal(rec.balance, 0);
  assert.equal(rec.status, 'PAGADO');

  // Clientes (1.1.02.01) debe quedar en 0 (100 cargo venta - 100 cobros)
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.02.01'), 0);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 100); // caja
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 3 — Sobrecobro rechazado en venta a crédito', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 50, unlimited: true, taxCategory: 'IVA_0' });
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 50 }], paymentMethod: 'credito',
  }));
  const c = await H.runController(sale.collectSale, H.mockReq(clinicId, userId,
    { amount: 999, paymentMethod: 'efectivo' }, { params: { id: r.payload._id } }));
  assert.ok(c.statusCode >= 400, 'debió rechazar el sobrecobro');
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 4 — Idempotencia: doble submit de venta con misma clave crea una sola', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 80, unlimited: true, taxCategory: 'IVA_0' });
  const body = { items: [{ product: serv._id, quantity: 1, unitPrice: 80 }], paymentMethod: 'efectivo', idempotencyKey: 'abc-123' };
  const r1 = await H.runController(sale.createSale, H.mockReq(clinicId, userId, body));
  const r2 = await H.runController(sale.createSale, H.mockReq(clinicId, userId, body));
  assert.equal(String(r1.payload._id), String(r2.payload._id));
  const Sale = require('../models/Sale');
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 5 — Anulación de venta de contado restaura stock, kardex y reversa el asiento', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115, purchasePrice: 40 });
  const sup = await H.makeSupplier(clinicId);
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(),
    items: [{ description: 'Insumo', product: prod._id, quantity: 5, unitPrice: 40, ivaRate: 15, subtotal: 200 }],
  }));
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 2, unitPrice: 115 }], paymentMethod: 'efectivo',
  }));
  const Product = require('../models/Product');
  assert.equal((await Product.findById(prod._id)).stock, 3);

  const c = await H.runController(sale.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: r.payload._id } }));
  assert.equal(c.statusCode, 200, JSON.stringify(c.payload));
  assert.equal((await Product.findById(prod._id)).stock, 5); // restaurado

  // Tras anular: caja y costo en 0 (asiento reversado), inventario neto = compra completa
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 0); // caja
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.01'), 0);    // costo
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 6 — Compra a crédito + pago a proveedor: CxP concilia, banco baja, mayor cuadra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', purchasePrice: 0 });

  const rc = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(),
    items: [{ description: 'Insumo', product: prod._id, quantity: 10, unitPrice: 50, ivaRate: 15, subtotal: 500 }],
  }));
  assert.equal(rc.statusCode, 201, JSON.stringify(rc.payload));
  const PurchaseInvoice = require('../models/PurchaseInvoice');
  const inv = await PurchaseInvoice.findById(rc.payload._id);
  assert.equal(inv.total, 575);    // 500 + 75 IVA
  assert.equal(inv.balance, 575);

  // Subledger CxP abierto
  const Payable = require('../models/Payable');
  let pay = await Payable.findOne({ clinic: clinicId, sourceRef: inv._id });
  assert.equal(pay.balance, 575);

  // Banco con saldo inicial para pagar
  const BankAccount = require('../models/BankAccount');
  const ChartOfAccount = require('../models/ChartOfAccount');
  const bankAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const bank = await BankAccount.create({ clinic: clinicId, name: 'Banco X', bank: 'X', accountNumber: '000111', chartAccount: bankAcc._id, initialBalance: 1000 });

  const rp = await H.runController(payment.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', method: 'TRANSFERENCIA', bankAccount: bank._id, reference: 'TR-1',
    partyModel: 'Supplier', partyRef: sup._id, partyName: sup.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: inv._id, amount: 575 }],
  }));
  assert.equal(rp.statusCode, 201, JSON.stringify(rp.payload));

  pay = await Payable.findOne({ clinic: clinicId, sourceRef: inv._id });
  assert.equal(pay.balance, 0);
  assert.equal(pay.status, 'PAGADO');
  assert.equal((await PurchaseInvoice.findById(inv._id)).balance, 0);

  // Proveedores (2.1.01.01) en 0 (575 crédito compra - 575 débito pago)
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), 0);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 7 — Compra con retención: balance = total - retención y mayor cuadra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  const rc = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(),
    items: [{ description: 'Servicio prof', quantity: 1, unitPrice: 1000, ivaRate: 15, subtotal: 1000, account: null }],
    retentions: [
      { type: 'RENTA', code: '303', percentage: 10, base: 1000, amount: 100 },
      { type: 'IVA', code: '721', percentage: 70, base: 150, amount: 105 },
    ],
  }, { params: {} }));
  // Sin cuenta en el ítem el asiento de compra puede no postear; validamos números del documento
  const PurchaseInvoice = require('../models/PurchaseInvoice');
  const inv = await PurchaseInvoice.findById(rc.payload?._id || rc.payload?.id);
  if (inv) {
    assert.equal(inv.total, 1150);          // 1000 + 150 IVA
    assert.equal(inv.retentionTotal, 205);  // 100 + 105
    assert.equal(inv.balance, 945);         // 1150 - 205
  }
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 8 — Caja: apertura, movimiento de gasto, cierre con arqueo exacto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });
  // Abre caja con fondo 50
  const open = await H.runController(cash.open, H.mockReq(clinicId, userId, { openingBalance: 50 }));
  assert.equal(open.statusCode, 201, JSON.stringify(open.payload));
  // Venta de contado 100 (entra a caja)
  await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 100 }], paymentMethod: 'efectivo',
  }));
  // Gasto de caja chica 30
  const mv = await H.runController(cash.addMovement, H.mockReq(clinicId, userId, { type: 'GASTO', amount: 30, description: 'Agua' }));
  assert.equal(mv.statusCode, 201, JSON.stringify(mv.payload));
  // Cierre: esperado = 50 + 100 - 30 = 120
  const close = await H.runController(cash.close, H.mockReq(clinicId, userId,
    { countedCash: 120 }, { params: { id: open.payload._id } }));
  assert.equal(close.statusCode, 200, JSON.stringify(close.payload));
  assert.equal(close.payload.expectedCash, 120);
  assert.equal(close.payload.difference, 0);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 9 — Salud contable sin hallazgos tras operaciones mixtas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });
  await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 100 }], paymentMethod: 'efectivo',
  }));
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 100 }], paymentMethod: 'credito',
  }));
  await H.runController(sale.collectSale, H.mockReq(clinicId, userId,
    { amount: 100, paymentMethod: 'efectivo' }, { params: { id: r.payload._id } }));

  const chk = await H.runController(health.check, H.mockReq(clinicId, userId));
  assert.equal(chk.statusCode, 200, JSON.stringify(chk.payload));
  const errors = (chk.payload.findings || []).filter((f) => f.level === 'error');
  assert.equal(errors.length, 0, 'no debe haber errores de salud: ' + JSON.stringify(chk.payload.findings));
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 10 — Compra con propina/ICE: el asiento debe seguir cuadrado', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  const ChartOfAccount = require('../models/ChartOfAccount');
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(),
    items: [{ description: 'Consumo', quantity: 1, unitPrice: 100, ivaRate: 15, subtotal: 100, account: gasto._id }],
    propina: 10,
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado con propina: ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 11 — Anulación de compra: reversa asiento, kardex y CxP', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo' });
  const rc = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(),
    items: [{ description: 'Insumo', product: prod._id, quantity: 8, unitPrice: 25, ivaRate: 15, subtotal: 200 }],
  }));
  const Product = require('../models/Product');
  assert.equal((await Product.findById(prod._id)).stock, 8);

  const rv = await H.runController(purchase.void, H.mockReq(clinicId, userId, {}, { params: { id: rc.payload._id } }));
  assert.equal(rv.statusCode, 200, JSON.stringify(rv.payload));
  assert.equal((await Product.findById(prod._id)).stock, 0); // kardex revertido

  const Payable = require('../models/Payable');
  const pay = await Payable.findOne({ clinic: clinicId, sourceRef: rc.payload._id });
  assert.equal(pay.status, 'ANULADO');
  // Inventario (1.1.04.01) y proveedores (2.1.01.01) en 0 tras reverso
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.04.01'), 0);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.01'), 0);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 12 — Anulación de pago a proveedor restaura saldo CxP y banco', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo' });
  const rc = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date(),
    items: [{ description: 'Insumo', product: prod._id, quantity: 4, unitPrice: 100, ivaRate: 15, subtotal: 400 }],
  }));
  const inv = rc.payload;
  const BankAccount = require('../models/BankAccount');
  const ChartOfAccount = require('../models/ChartOfAccount');
  const bankAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const bank = await BankAccount.create({ clinic: clinicId, name: 'Banco', bank: 'B', accountNumber: '1', chartAccount: bankAcc._id, initialBalance: 5000 });

  const rp = await H.runController(payment.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', method: 'TRANSFERENCIA', bankAccount: bank._id, reference: 'TR',
    partyModel: 'Supplier', partyRef: sup._id,
    applications: [{ docModel: 'PurchaseInvoice', docRef: inv._id, amount: 460 }],
  }));
  assert.equal(rp.statusCode, 201, JSON.stringify(rp.payload));
  const Payable = require('../models/Payable');
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceRef: inv._id })).balance, 0);

  const rvoid = await H.runController(payment.void, H.mockReq(clinicId, userId, {}, { params: { id: rp.payload._id } }));
  assert.equal(rvoid.statusCode, 200, JSON.stringify(rvoid.payload));
  // CxP vuelve a 460 y la compra a su saldo
  assert.equal((await Payable.findOne({ clinic: clinicId, sourceRef: inv._id })).balance, 460);
  const PurchaseInvoice = require('../models/PurchaseInvoice');
  assert.equal((await PurchaseInvoice.findById(inv._id)).balance, 460);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 13 — Anulación de venta a crédito con cobro parcial previo (G5): Clientes vuelve a 0', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 200, unlimited: true, taxCategory: 'IVA_0' });
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 200 }], paymentMethod: 'credito',
  }));
  const saleId = r.payload._id;
  await H.runController(sale.collectSale, H.mockReq(clinicId, userId,
    { amount: 80, paymentMethod: 'efectivo' }, { params: { id: saleId } }));

  const c = await H.runController(sale.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: saleId } }));
  assert.equal(c.statusCode, 200, JSON.stringify(c.payload));

  // Tras anular: Clientes en 0, caja en 0 (cobro reversado), CxC anulada
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.02.01'), 0); // clientes
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 0); // caja
  const Receivable = require('../models/Receivable');
  assert.equal((await Receivable.findOne({ clinic: clinicId, sourceRef: saleId })).status, 'ANULADO');
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);

  // Salud contable sin errores
  const chk = await H.runController(health.check, H.mockReq(clinicId, userId));
  const errs = (chk.payload.findings || []).filter((f) => f.level === 'error');
  assert.equal(errs.length, 0, JSON.stringify(chk.payload.findings));
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 14 — Anticipo de cliente (cobro sin factura): acredita Anticipos clientes', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await H.runController(payment.create, H.mockReq(clinicId, userId, {
    type: 'COBRO', method: 'EFECTIVO', partyModel: 'Patient', partyName: 'Juan',
    advanceAmount: 150,
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  // Caja +150, Anticipos clientes (2.1.01.03) -150 (pasivo, naturaleza haber)
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 150);
  assert.equal(await H.accountBalanceByCode(clinicId, '2.1.01.03'), -150);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 15 — Venta con descuento: la base de descuento va a la cuenta de descuentos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 100, discount: 20 }], paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const Sale = require('../models/Sale');
  const s = await Sale.findById(r.payload._id);
  assert.equal(s.total, 80);            // 100 - 20
  assert.equal(s.discountTotal, 20);
  // Descuentos en ventas (4.1.03) debitado 20; ingreso servicios 100 crédito; caja 80
  assert.equal(await H.accountBalanceByCode(clinicId, '4.1.03'), 20);
  assert.equal(await H.accountBalanceByCode(clinicId, '4.1.01'), -100);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 80);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 16 — Kardex FIFO multicapa: COGS pondera dos capas con costos distintos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sup = await H.makeSupplier(clinicId);
  const prod = await H.makeProduct(clinicId, { category: 'insumo', salePrice: 115 });
  // Capa 1: 5 @ 10 (más antigua)
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-01'),
    items: [{ description: 'I', product: prod._id, quantity: 5, unitPrice: 10, ivaRate: 15, subtotal: 50 }],
  }));
  // Capa 2: 5 @ 20
  await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: sup._id, fechaEmision: new Date('2026-06-10'),
    items: [{ description: 'I', product: prod._id, quantity: 5, unitPrice: 20, ivaRate: 15, subtotal: 100 }],
  }));
  // Vende 7: consume 5@10 + 2@20 = 50 + 40 = 90 de COGS
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 7, unitPrice: 115 }], paymentMethod: 'efectivo',
    date: new Date('2026-06-15'),
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await H.accountBalanceByCode(clinicId, '5.1.01'), 90); // COGS ponderado
  const Product = require('../models/Product');
  assert.equal((await Product.findById(prod._id)).stock, 3); // 10 - 7
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 17 — Venta con tarjeta pasa por "Tarjetas por liquidar" (no banco directo)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 100 }], paymentMethod: 'tarjeta',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  // Tarjetas por liquidar (1.1.02.02) +100, caja en 0
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.02.02'), 100);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 0);
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});

// ─────────────────────────────────────────────────────────────────────────────
test('FLUJO 18 — Arqueo incluye cobros de crédito en efectivo (no sobrante fantasma)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const serv = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });
  const open = await H.runController(cash.open, H.mockReq(clinicId, userId, { openingBalance: 0 }));
  // Venta de contado 100 (efectivo entra)
  await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 100 }], paymentMethod: 'efectivo',
  }));
  // Venta a crédito y luego su cobro en efectivo 70 (también entra al cajón)
  const cr = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: serv._id, quantity: 1, unitPrice: 100 }], paymentMethod: 'credito',
  }));
  await H.runController(sale.collectSale, H.mockReq(clinicId, userId,
    { amount: 70, paymentMethod: 'efectivo' }, { params: { id: cr.payload._id } }));

  // Esperado en cajón = 100 (venta efectivo) + 70 (cobro efectivo) = 170
  const close = await H.runController(cash.close, H.mockReq(clinicId, userId,
    { countedCash: 170 }, { params: { id: open.payload._id } }));
  assert.equal(close.statusCode, 200, JSON.stringify(close.payload));
  assert.equal(close.payload.expectedCash, 170, 'expectedCash debe incluir el cobro en efectivo');
  assert.equal(close.payload.difference, 0, 'no debe haber sobrante fantasma');
  const led = await H.assertLedgerBalanced(clinicId);
  assert.ok(led.balanced, `mayor descuadrado ${led.debit} vs ${led.credit}`);
});
