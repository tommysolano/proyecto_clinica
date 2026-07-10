/**
 * Pago dividido y crédito en ventas.
 * Una venta puede pagarse con varios métodos a la vez (efectivo + tarjeta +
 * transferencia) y/o dejar una parte a crédito (CxC). El asiento debe debitar
 * cada método en su cuenta (caja / banco / tarjetas por liquidar / clientes),
 * abrir CxC solo por la parte a crédito y permitir abonos posteriores.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const sale = require('../controllers/saleController');
const cashClosing = require('../controllers/cashClosingController');
const ChartOfAccount = require('../models/ChartOfAccount');
const Receivable = require('../models/Receivable');
const Sale = require('../models/Sale');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Producto ilimitado (servicio-like) para no depender de kardex/costo. */
async function serviceProduct(clinicId) {
  return H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0', taxRate: 0, priceIncludesVat: false });
}

// ─────────────────────────────────────────────────────────────────────────────
test('1) mitad efectivo + mitad tarjeta: debita caja y tarjetas por liquidar, sin CxC', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await serviceProduct(clinicId);
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 1, unitPrice: 100 }],
    payments: [
      { method: 'efectivo', amount: 50 },
      { method: 'tarjeta', amount: 50 },
    ],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const s = await Sale.findById(r.payload._id);
  assert.equal(s.total, 100);
  assert.equal(s.paymentMethod, 'mixto');
  assert.equal(s.payments.length, 2);
  assert.equal(s.paid, true);
  assert.equal(s.balance, 0);

  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 50, 'caja 50');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.02.02'), 50, 'tarjetas por liquidar 50');
  assert.equal(await Receivable.countDocuments({ clinic: clinicId }), 0, 'sin CxC');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('2) parte al contado + parte a crédito: CxC solo por la parte a crédito, con abono posterior', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await serviceProduct(clinicId);
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 1, unitPrice: 100 }],
    payments: [
      { method: 'efectivo', amount: 30 },
      { method: 'credito', amount: 70 },
    ],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const s = await Sale.findById(r.payload._id);
  assert.equal(s.paid, false);
  assert.equal(s.balance, 70, 'saldo = parte a crédito');

  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 30, 'caja 30');
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.02.01'), 70, 'clientes/CxC 70');
  const cxc = await Receivable.findOne({ clinic: clinicId, sourceRef: s._id });
  assert.ok(cxc, 'CxC abierta');
  assert.equal(cxc.total, 70, 'la CxC es por la parte a crédito, no por el total');
  assert.equal(cxc.balance, 70);
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);

  // Abono de 40 sobre la parte a crédito.
  const col = await H.runController(sale.collectSale, H.mockReq(clinicId, userId, { amount: 40, paymentMethod: 'efectivo' }, { params: { id: String(s._id) } }));
  assert.equal(col.statusCode, 200, JSON.stringify(col.payload));
  assert.equal(col.payload.balance, 30);
  assert.equal(col.payload.paid, false);
  assert.equal((await Receivable.findById(cxc._id)).balance, 30);

  // Abono final saldando.
  const col2 = await H.runController(sale.collectSale, H.mockReq(clinicId, userId, { amount: 30, paymentMethod: 'efectivo' }, { params: { id: String(s._id) } }));
  assert.equal(col2.statusCode, 200, JSON.stringify(col2.payload));
  assert.equal(col2.payload.paid, true);
  assert.equal(col2.payload.balance, 0);
  assert.equal((await Receivable.findById(cxc._id)).status, 'PAGADO');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);
});

// ─────────────────────────────────────────────────────────────────────────────
test('3) los pagos deben cuadrar con el total (rechaza si no)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await serviceProduct(clinicId);
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 1, unitPrice: 100 }],
    payments: [
      { method: 'efectivo', amount: 30 },
      { method: 'tarjeta', amount: 50 }, // suma 80 ≠ 100
    ],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.error || r.payload.message, /no cuadran|total/i);
  assert.equal(await Sale.countDocuments({ clinic: clinicId }), 0, 'no crea la venta');
});

// ─────────────────────────────────────────────────────────────────────────────
test('4) venta clásica de un solo método sigue igual (compatibilidad)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await serviceProduct(clinicId);
  const r = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 1, unitPrice: 100 }],
    paymentMethod: 'efectivo',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const s = await Sale.findById(r.payload._id);
  assert.equal(s.paymentMethod, 'efectivo');
  assert.equal(s.payments.length, 1, 'se sintetiza un pago único');
  assert.equal(s.payments[0].method, 'efectivo');
  assert.equal(s.payments[0].amount, 100);
  assert.equal(await H.accountBalanceByCode(clinicId, '1.1.01.01'), 100);
});

// ─────────────────────────────────────────────────────────────────────────────
test('5) arqueo por método reparte el pago dividido (efectivo y tarjeta por separado)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const prod = await serviceProduct(clinicId);
  await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: prod._id, quantity: 1, unitPrice: 100 }],
    payments: [{ method: 'efectivo', amount: 60 }, { method: 'tarjeta', amount: 40 }],
  }));
  const res = await H.runController(cashClosing.summary, H.mockReq(clinicId, userId, {}, { query: {} }));
  assert.equal(res.statusCode, 200, JSON.stringify(res.payload));
  assert.equal(res.payload.byMethod.efectivo, 60, 'efectivo cuenta 60, no el total');
  assert.equal(res.payload.byMethod.tarjeta, 40);
  assert.equal(res.payload.salesCount, 1, 'una venta (no dos por los dos pagos)');
  assert.equal(res.payload.totalSales, 100);
});
