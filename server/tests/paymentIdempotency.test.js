/**
 * Idempotencia de pagos/cobros (Payment.idempotencyKey).
 * Evita que un doble clic / reintento de red registre el mismo cobro o pago dos veces:
 * no duplica Payment, ni JournalEntry, ni BankTransaction, ni la aplicación a CxP/CxC.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const purchase = require('../controllers/purchaseInvoiceController');
const payments = require('../controllers/paymentController');
const ChartOfAccount = require('../models/ChartOfAccount');
const BankAccount = require('../models/BankAccount');
const Payment = require('../models/Payment');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const BankTransaction = require('../models/BankTransaction');
const JournalEntry = require('../models/JournalEntry');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const gastoLine = (acc, val = 100) => ({ description: 'Gasto', lineType: 'GASTO', account: acc, quantity: 1, unitPrice: val, ivaRate: 0, subtotal: val });

async function makeGastoPurchase(clinicId, userId, supplier, { serie = '001-001-000000001', val = 100 } = {}) {
  const gasto = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const r = await H.runController(purchase.create, H.mockReq(clinicId, userId, {
    supplier: supplier._id, fechaEmision: H.docDate(), serie, items: [gastoLine(gasto._id, val)],
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  return r.payload;
}

// ─────────────────────────────────────────────────────────────────────────────
test('1) doble submit con misma key: un solo Payment, un solo asiento, sin doble aplicación CxP', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const sup = await H.makeSupplier(clinicId);
  const pi = await makeGastoPurchase(clinicId, userId, sup, { serie: '001-001-000000101', val: 100 });

  const body = {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: sup._id, partyName: sup.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(pi._id), amount: 60 }],
    idempotencyKey: 'PAY-K1',
  };
  const first = await H.runController(payments.create, H.mockReq(clinicId, userId, body));
  assert.equal(first.statusCode, 201, JSON.stringify(first.payload));

  const replay = await H.runController(payments.create, H.mockReq(clinicId, userId, body));
  assert.equal(replay.statusCode, 200, 'la repetición NO crea otro pago');
  assert.equal(replay.payload.idempotentReplay, true);
  assert.equal(String(replay.payload._id), String(first.payload._id), 'devuelve el mismo pago');

  assert.equal(await Payment.countDocuments({ clinic: clinicId, idempotencyKey: 'PAY-K1' }), 1, 'un solo Payment');
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'PAGO', sourceModel: 'Payment', sourceRef: first.payload._id }), 1, 'un solo asiento');
  const piAfter = await PurchaseInvoice.findById(pi._id);
  assert.equal(piAfter.balance, 40, 'la CxP se redujo UNA sola vez (100 - 60)');
});

// ─────────────────────────────────────────────────────────────────────────────
test('2) doble submit por banco con misma key: un solo BankTransaction', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const sup = await H.makeSupplier(clinicId);
  const pi = await makeGastoPurchase(clinicId, userId, sup, { serie: '001-001-000000102', val: 100 });
  const bankAcc = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.03' });
  const bank = await BankAccount.create({ clinic: clinicId, name: 'Cta Cte', bank: 'Pichincha', accountNumber: '123', chartAccount: bankAcc._id });

  const body = {
    type: 'PAGO', method: 'TRANSFERENCIA', bankAccount: String(bank._id), voucherNumber: 'TRX-1',
    partyModel: 'Supplier', partyRef: sup._id, partyName: sup.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(pi._id), amount: 100 }],
    idempotencyKey: 'PAY-K2',
  };
  const first = await H.runController(payments.create, H.mockReq(clinicId, userId, body));
  assert.equal(first.statusCode, 201, JSON.stringify(first.payload));
  const replay = await H.runController(payments.create, H.mockReq(clinicId, userId, body));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.idempotentReplay, true);

  assert.equal(await BankTransaction.countDocuments({ clinic: clinicId, sourceModel: 'Payment', sourceRef: first.payload._id }), 1, 'un solo movimiento bancario');
  assert.equal(await Payment.countDocuments({ clinic: clinicId, idempotencyKey: 'PAY-K2' }), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
test('3) pre-check: si la clave ya existe, replay sin recrear (concurrencia)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const sup = await H.makeSupplier(clinicId);
  // Simula que otra petición ya creó el pago con esa clave (carrera ganada).
  const body = {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: sup._id, partyName: 'X',
    advanceAmount: 50, applications: [], idempotencyKey: 'PAY-K3',
  };
  const first = await H.runController(payments.create, H.mockReq(clinicId, userId, body));
  assert.equal(first.statusCode, 201);
  const replay = await H.runController(payments.create, H.mockReq(clinicId, userId, body));
  assert.equal(replay.statusCode, 200);
  assert.equal(replay.payload.idempotentReplay, true);
  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 1, 'un solo Payment en total');
});

// ─────────────────────────────────────────────────────────────────────────────
test('4) la misma key en OTRA clínica sí puede coexistir', async () => {
  const a = await H.seedClinic({ date: H.docDate() });
  const b = await H.seedClinic({ date: H.docDate() });
  const supA = await H.makeSupplier(a.clinicId);
  const supB = await H.makeSupplier(b.clinicId);
  const mk = (clinicId, supplier) => ({ type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: supplier._id, partyName: 'X', advanceAmount: 25, applications: [], idempotencyKey: 'SHARED-KEY' });
  const rA = await H.runController(payments.create, H.mockReq(a.clinicId, a.userId, mk(a.clinicId, supA)));
  const rB = await H.runController(payments.create, H.mockReq(b.clinicId, b.userId, mk(b.clinicId, supB)));
  assert.equal(rA.statusCode, 201);
  assert.equal(rB.statusCode, 201, 'misma clave en otra clínica no colisiona');
  assert.notEqual(String(rA.payload._id), String(rB.payload._id));
});

// ─────────────────────────────────────────────────────────────────────────────
test('5) sin key: comportamiento legacy (dos pagos distintos, no idempotente)', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const sup = await H.makeSupplier(clinicId);
  const body = { type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: sup._id, partyName: 'X', advanceAmount: 10, applications: [] };
  const r1 = await H.runController(payments.create, H.mockReq(clinicId, userId, body));
  const r2 = await H.runController(payments.create, H.mockReq(clinicId, userId, body));
  assert.equal(r1.statusCode, 201);
  assert.equal(r2.statusCode, 201);
  assert.notEqual(String(r1.payload._id), String(r2.payload._id), 'sin clave se crean dos pagos');
  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 2);
});
