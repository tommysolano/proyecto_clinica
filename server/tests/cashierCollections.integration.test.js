const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const sale = require('../controllers/saleController');
const reports = require('../controllers/accountingReportsController');
const Sale = require('../models/Sale');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('cobros por cajero suma pagos mixtos y el abono posterior, sin sumar crédito como dinero', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const product = await H.makeProduct(clinicId, { category: 'servicio', salePrice: 100, unlimited: true, taxCategory: 'IVA_0' });
  const created = await H.runController(sale.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: product._id, quantity: 1, unitPrice: 100 }],
    payments: [{ method: 'efectivo', amount: 60 }, { method: 'credito', amount: 40 }],
  }));
  assert.equal(created.statusCode, 201, JSON.stringify(created.payload));
  const query = { startDate: new Date().toISOString().slice(0, 10), endDate: new Date().toISOString().slice(0, 10) };
  const before = await H.runController(reports.collectionsByCashier, H.mockReq(clinicId, userId, {}, { query }));
  assert.equal(before.statusCode, 200, JSON.stringify(before.payload));
  assert.equal(before.payload.total, 60);
  for (const paymentMethod of ['tarjeta', 'transferencia']) {
    const invalid = await H.runController(sale.collectSale, H.mockReq(clinicId, userId,
      { amount: 40, paymentMethod }, { params: { id: created.payload._id } }));
    assert.equal(invalid.statusCode, 400, JSON.stringify(invalid.payload));
  }
  assert.equal((await Sale.findById(created.payload._id)).balance, 40);
  const collected = await H.runController(sale.collectSale, H.mockReq(clinicId, userId,
    { amount: 40, paymentMethod: 'efectivo' }, { params: { id: created.payload._id } }));
  assert.equal(collected.statusCode, 200, JSON.stringify(collected.payload));
  const after = await H.runController(reports.collectionsByCashier, H.mockReq(clinicId, userId, {}, { query }));
  assert.equal(after.statusCode, 200, JSON.stringify(after.payload));
  assert.equal(after.payload.total, 100);
  assert.equal(after.payload.events.length, 2);
  assert.equal(after.payload.summary[0].byMethod.EFECTIVO, 100);
});
