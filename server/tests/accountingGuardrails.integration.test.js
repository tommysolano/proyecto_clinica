const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const payments = require('../controllers/paymentController');
const purchases = require('../controllers/purchaseInvoiceController');
const journal = require('../controllers/journalEntryController');
const periods = require('../controllers/fiscalPeriodController');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Payment = require('../models/Payment');
const JournalEntry = require('../models/JournalEntry');
const ChartOfAccount = require('../models/ChartOfAccount');
const FiscalPeriod = require('../models/FiscalPeriod');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('una compra importada sin contabilizar no se paga por ninguna ruta', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const supplier = await H.makeSupplier(clinicId);
  const invoice = await PurchaseInvoice.create({
    clinic: clinicId, supplier: supplier._id, fechaEmision: H.docDate(),
    serie: '001-001-000000991', status: 'POR_AUTORIZAR', importedFromXml: true,
    total: 100, balance: 100,
  });

  const individual = await H.runController(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: supplier._id,
    partyName: supplier.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(invoice._id), amount: 40 }],
  }));
  assert.equal(individual.statusCode, 409, JSON.stringify(individual.payload));
  assert.equal(individual.payload.code, 'NOT_POSTED');

  const bulk = await H.runController(payments.createBulk, H.mockReq(clinicId, userId, {
    method: 'EFECTIVO', items: [{ purchaseInvoice: String(invoice._id), amount: 40 }],
  }));
  assert.equal(bulk.statusCode, 409, JSON.stringify(bulk.payload));
  assert.equal(bulk.payload.code, 'NOT_POSTED');
  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 0);
  assert.equal((await PurchaseInvoice.findById(invoice._id)).balance, 100);
  assert.equal(await JournalEntry.countDocuments({ clinic: clinicId, source: 'PAGO' }), 0);
});

test('una compra con asiento faltante o reversado tampoco admite pagos', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const supplier = await H.makeSupplier(clinicId);
  const expense = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const created = await H.runController(purchases.create, H.mockReq(clinicId, userId, {
    supplier: supplier._id, fechaEmision: H.docDate(), serie: '001-001-000000992',
    items: [{ description: 'Gasto', lineType: 'GASTO', account: expense._id,
      quantity: 1, unitPrice: 100, subtotal: 100, ivaRate: 0 }],
  }));
  assert.equal(created.statusCode, 201, JSON.stringify(created.payload));
  const invoice = created.payload;
  await JournalEntry.updateOne({ _id: invoice.journalEntry }, { $set: { isReversed: true } });

  const paid = await H.runController(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: supplier._id,
    partyName: supplier.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(invoice._id), amount: 20 }],
  }));
  assert.equal(paid.statusCode, 409, JSON.stringify(paid.payload));
  assert.equal(paid.payload.code, 'NOT_POSTED');
  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 0);

  await PurchaseInvoice.updateOne({ _id: invoice._id }, { $set: { journalEntry: null } });
  const missing = await H.runController(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: supplier._id,
    partyName: supplier.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(invoice._id), amount: 20 }],
  }));
  assert.equal(missing.statusCode, 409, JSON.stringify(missing.payload));
  assert.equal(missing.payload.code, 'NOT_POSTED');
});

test('la compra migrada con asiento externo no abre una segunda CxP al pagar', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const supplier = await H.makeSupplier(clinicId);
  const cash = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const expense = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const entry = await JournalEntry.create({
    clinic: clinicId, number: 'CTF-TEST-001', date: H.docDate(), status: 'CONTABILIZADO',
    source: 'MIGRACION', sourceModel: 'ContificoRecord', sourceRef: new H.mongoose.Types.ObjectId(),
    sourceAction: 'IMPORT',
    lines: [{ account: expense._id, debit: 100 }, { account: cash._id, credit: 100 }],
  });
  const invoice = await PurchaseInvoice.create({
    clinic: clinicId, supplier: supplier._id, fechaEmision: H.docDate(),
    serie: 'CTF-001', status: 'REGISTRADA', total: 100, balance: 100,
    sourceModel: 'ContificoRecord', sourceRef: new H.mongoose.Types.ObjectId(), journalEntry: entry._id,
  });
  const result = await H.runController(payments.create, H.mockReq(clinicId, userId, {
    type: 'PAGO', method: 'EFECTIVO', partyModel: 'Supplier', partyRef: supplier._id,
    partyName: supplier.razonSocial,
    applications: [{ docModel: 'PurchaseInvoice', docRef: String(invoice._id), amount: 20 }],
  }));
  assert.equal(result.statusCode, 409, JSON.stringify(result.payload));
  assert.equal(result.payload.code, 'MIGRATED_PAYABLE_REVIEW');
  assert.equal(await Payment.countDocuments({ clinic: clinicId }), 0);
  assert.equal((await PurchaseInvoice.findById(invoice._id)).balance, 100);
});

test('el diario rechaza reversar documentos operativos y permite un asiento manual', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const supplier = await H.makeSupplier(clinicId);
  const expense = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const cash = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const created = await H.runController(purchases.create, H.mockReq(clinicId, userId, {
    supplier: supplier._id, fechaEmision: H.docDate(), serie: '001-001-000000993',
    items: [{ description: 'Gasto', lineType: 'GASTO', account: expense._id,
      quantity: 1, unitPrice: 100, subtotal: 100, ivaRate: 0 }],
  }));
  assert.equal(created.statusCode, 201, JSON.stringify(created.payload));

  const blocked = await H.runController(journal.reverse, H.mockReq(clinicId, userId,
    { reason: 'Prueba' }, { params: { id: String(created.payload.journalEntry) } }));
  assert.equal(blocked.statusCode, 409, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, 'DOCUMENT_REVERSAL_REQUIRED');
  assert.equal((await JournalEntry.findById(created.payload.journalEntry)).isReversed, false);
  assert.equal((await PurchaseInvoice.findById(created.payload._id)).status, 'REGISTRADA');

  const operationalAdjustment = await JournalEntry.create({
    clinic: clinicId, number: 'AS-OP-000001', date: H.docDate(),
    source: 'AJUSTE', sourceModel: 'CashMovement', sourceRef: new H.mongoose.Types.ObjectId(),
    sourceAction: 'POST', status: 'CONTABILIZADO',
    lines: [{ account: cash._id, debit: 5 }, { account: expense._id, credit: 5 }],
  });
  const adjustmentBlocked = await H.runController(journal.reverse, H.mockReq(clinicId, userId,
    { reason: 'Prueba' }, { params: { id: String(operationalAdjustment._id) } }));
  assert.equal(adjustmentBlocked.statusCode, 409, JSON.stringify(adjustmentBlocked.payload));
  assert.equal(adjustmentBlocked.payload.code, 'DOCUMENT_REVERSAL_REQUIRED');

  const manual = await H.runController(journal.create, H.mockReq(clinicId, userId, {
    date: H.docDate(), description: 'Ajuste manual de prueba',
    lines: [
      { account: cash._id, debit: 10, credit: 0 },
      { account: expense._id, debit: 0, credit: 10 },
    ],
  }));
  assert.equal(manual.statusCode, 201, JSON.stringify(manual.payload));
  const reversed = await H.runController(journal.reverse, H.mockReq(clinicId, userId,
    { reason: 'Corrección manual' }, { params: { id: String(manual.payload._id) } }));
  assert.equal(reversed.statusCode, 200, JSON.stringify(reversed.payload));
  assert.equal((await JournalEntry.findById(manual.payload._id)).isReversed, true);
});

test('un período con asientos en borrador no se cierra', async () => {
  const { clinicId, userId } = await H.seedClinic({ date: H.docDate() });
  const period = await FiscalPeriod.findOne({
    clinic: clinicId, year: H.docDate().getFullYear(), month: H.docDate().getMonth() + 1,
  });
  const cash = await ChartOfAccount.findOne({ clinic: clinicId, code: '1.1.01.01' });
  const expense = await ChartOfAccount.findOne({ clinic: clinicId, code: '6.1.99' });
  const draft = await H.runController(journal.create, H.mockReq(clinicId, userId, {
    date: H.docDate(), description: 'Pendiente de aprobación', draft: true,
    lines: [{ account: cash._id, debit: 10 }, { account: expense._id, credit: 10 }],
  }));
  assert.equal(draft.statusCode, 201, JSON.stringify(draft.payload));

  const blocked = await H.runController(periods.close, H.mockReq(clinicId, userId,
    {}, { params: { id: String(period._id) } }));
  assert.equal(blocked.statusCode, 409, JSON.stringify(blocked.payload));
  assert.equal(blocked.payload.code, 'DRAFTS_PENDING');
  assert.equal((await FiscalPeriod.findById(period._id)).status, 'ABIERTO');

  const annualBlocked = await H.runController(periods.closeYear, H.mockReq(clinicId, userId,
    { year: period.year }));
  assert.equal(annualBlocked.statusCode, 409, JSON.stringify(annualBlocked.payload));
  assert.equal(annualBlocked.payload.code, 'DRAFTS_PENDING');
  assert.equal((await FiscalPeriod.findById(period._id)).status, 'ABIERTO');

  const removed = await H.runController(journal.removeDraft, H.mockReq(clinicId, userId,
    {}, { params: { id: String(draft.payload._id) } }));
  assert.equal(removed.statusCode, 200);
  const closed = await H.runController(periods.close, H.mockReq(clinicId, userId,
    {}, { params: { id: String(period._id) } }));
  assert.equal(closed.statusCode, 200, JSON.stringify(closed.payload));
  assert.equal((await FiscalPeriod.findById(period._id)).status, 'CERRADO');
});
