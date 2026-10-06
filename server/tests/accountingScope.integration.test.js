/**
 * CONTABILIDAD POR SUCURSAL: una empresa, tres centros de costo.
 *
 * Todo lo de Contífico vive en Central. Central, Extensión y Laboratorio están ligadas a
 * su centro (Clinic.accountingCostCenter) y cada una debe ver SUS documentos; «Toda la
 * empresa» los ve todos. Caso real: en Laboratorio, Compras salía vacío.
 *
 * Y el centro de una compra de bodega: Contífico no lo pone en el documento, solo en el
 * asiento de la compra. services/contificoCostCenters lo toma de ahí.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const H = require('./_integrationHelpers');

const scopeMiddleware = require('../middleware/accountingScope');
const purchases = require('../controllers/purchaseInvoiceController');
const sales = require('../controllers/saleController');
const subledger = require('../controllers/subledgerController');
const costCenters = require('../controllers/costCenterController');
const { refreshCostCenters } = require('../services/contificoCostCenters');

const Clinic = require('../models/Clinic');
const CostCenter = require('../models/CostCenter');
const PurchaseInvoice = require('../models/PurchaseInvoice');
const Sale = require('../models/Sale');
const Payable = require('../models/Payable');
const Record = require('../models/ContificoRecord');
const JournalEntry = require('../models/JournalEntry');

const { ObjectId } = H.mongoose.Types;

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedCompany() {
  const central = new ObjectId();
  const [ccCentral, ccLab] = [new ObjectId(), new ObjectId()];
  await CostCenter.collection.insertMany([
    { _id: ccCentral, clinic: central, code: '1', name: 'CC CENTRAL', active: true },
    { _id: ccLab, clinic: central, code: '5', name: 'CC LABORATORIO', active: true },
  ]);
  const lab = new ObjectId();
  const odonto = new ObjectId();
  await Clinic.collection.insertMany([
    { _id: central, name: 'Central', active: true, accountingCostCenter: ccCentral },
    { _id: lab, name: 'Laboratorio', active: true, accountingCostCenter: ccLab },
    { _id: odonto, name: 'Odontología', active: true },
  ]);
  return { central, lab, odonto, ccCentral, ccLab };
}

/** Pasa la petición por el middleware de alcance y luego por el controller. */
async function scoped(handler, clinicId, { query = {}, company = false, method = 'GET' } = {}) {
  const req = H.mockReq(String(clinicId), new ObjectId(), {}, {
    query, headers: company ? { 'x-accounting-scope': 'company' } : {} });
  req.method = method;
  req.path = '/';
  await new Promise((resolve, reject) => scopeMiddleware()(req, {}, (error) => (error ? reject(error) : resolve())));
  return { req, out: await H.runController(handler, req) };
}

const purchaseDoc = (clinic, serie, center, extra = {}) => ({
  clinic, serie, supplier: new ObjectId(), docType: 'FACTURA', fechaEmision: new Date('2026-09-10T12:00:00Z'),
  total: 100, balance: 0, status: 'PAGADA', costCenter: center,
  items: [{ description: 'x', quantity: 1, unitPrice: 100, subtotal: 100, costCenter: center }], ...extra,
});

test('cada sucursal ligada ve las compras, ventas y cartera de su centro; la empresa, todas', async () => {
  const { central, lab, ccCentral, ccLab } = await seedCompany();
  await PurchaseInvoice.collection.insertMany([
    purchaseDoc(central, '001-001-1', ccCentral),
    purchaseDoc(central, '001-001-2', ccLab),
    purchaseDoc(central, '001-001-3', null),
  ]);
  await Sale.collection.insertMany([
    { clinic: central, status: 'completada', total: 10, costCenter: ccLab, createdAt: new Date() },
    { clinic: central, status: 'completada', total: 20, costCenter: ccCentral, createdAt: new Date() },
  ]);
  await Payable.collection.insertOne({ clinic: central, status: 'ABIERTO', balance: 5, total: 5,
    costCenter: ccLab, party: { name: 'Proveedor' }, issueDate: new Date(), number: '1' });

  const labPurchases = (await scoped(purchases.list, lab)).out.payload;
  assert.deepEqual(labPurchases.items.map((p) => p.serie), ['001-001-2']);
  const centralPurchases = (await scoped(purchases.list, central)).out.payload;
  assert.deepEqual(centralPurchases.items.map((p) => p.serie), ['001-001-1']);
  // Toda la empresa: incluso la compra que Contífico dejó sin centro.
  assert.equal((await scoped(purchases.list, lab, { company: true })).out.payload.total, 3);

  assert.deepEqual((await scoped(sales.getSales, lab)).out.payload.sales.map((s) => s.total), [10]);
  assert.equal((await scoped(subledger.list, lab, { query: { side: 'AP' } })).out.payload.length, 1);
  assert.equal((await scoped(subledger.list, central, { query: { side: 'AP' } })).out.payload.length, 0);

  const scope = (await scoped(costCenters.scope, lab)).out.payload;
  assert.equal(scope.linked, true);
  assert.equal(scope.costCenter.name, 'CC LABORATORIO');
});

test('una sucursal sin centro ligado conserva sus propios datos', async () => {
  const { central, odonto } = await seedCompany();
  await PurchaseInvoice.collection.insertOne(purchaseDoc(central, '001-001-9', null));
  const { req, out } = await scoped(purchases.list, odonto);
  assert.equal(req.clinicId, String(odonto));
  assert.equal(out.payload.total, 0);
  assert.equal((await scoped(costCenters.scope, odonto)).out.payload.linked, false);
});

test('en las rutas de solo lectura, una escritura sigue en la sucursal activa', async () => {
  const { lab } = await seedCompany();
  const req = H.mockReq(String(lab), new ObjectId());
  req.method = 'POST';
  req.path = '/';
  await new Promise((resolve) => scopeMiddleware({ reads: true })(req, {}, resolve));
  assert.equal(req.clinicId, String(lab));
  assert.equal(req.costCenterScope, undefined);
});

test('la compra de bodega toma su centro del asiento de la compra, no del de pago', async () => {
  const { central, ccLab } = await seedCompany();
  const gz = (payload) => zlib.gzipSync(Buffer.from(JSON.stringify(payload)));
  await Record.collection.insertOne({ clinic: central, entity: 'cost_center', externalId: 'LAB',
    payloadCompressed: gz({ codigo: '5', nombre: 'CC LABORATORIO' }), checksum: 'x' });
  const record = new ObjectId();
  await Record.collection.insertOne({ _id: record, clinic: central, entity: 'document', externalId: 'DOC1', checksum: 'x',
    payloadCompressed: gz({ descripcion: 'INVENTARIO LAB F/. 001-001-7', detalles: [{ centro_costo_id: null }, { centro_costo_id: null }] }) });
  const date = new Date('2026-09-10T12:00:00Z');
  await PurchaseInvoice.collection.insertOne(purchaseDoc(central, '001-001-7', null, {
    sourceModel: 'ContificoRecord', sourceRef: record, total: 150,
    items: [{ description: 'a', subtotal: 100, costCenter: null }, { description: 'b', subtotal: 50, costCenter: null }] }));
  await Payable.collection.insertOne({ clinic: central, sourceModel: 'ContificoRecord', sourceRef: record,
    issueDate: date, status: 'ABIERTO', balance: 150, total: 150, costCenter: null });
  const line = (accountCode, debit, credit, costCenter = null) => ({ account: new ObjectId(), accountCode, debit, credit, costCenter });
  await JournalEntry.collection.insertMany([
    // Asiento de la compra: la glosa es la descripción del documento y el inventario lleva el centro.
    { clinic: central, number: 'CTF-A', status: 'CONTABILIZADO', date, description: 'INVENTARIO LAB F/. 001-001-7',
      lines: [line('1.1.3.6', 100, 0, ccLab), line('1.1.3.6', 50, 0, ccLab), line('2.1.3.1.1', 0, 150)] },
    // El pago empieza por «Doc.» y no decide nada.
    { clinic: central, number: 'CTF-B', status: 'CONTABILIZADO', date, description: 'Doc. 001-001-7, INVENTARIO LAB F/. 001-001-7',
      lines: [line('2.1.3.1.1', 150, 0), line('1.1.1.3', 0, 150)] },
  ]);

  const range = { clinicId: central, from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-30T23:59:59Z') };
  assert.equal((await refreshCostCenters({ ...range, commit: false })).purchases, 1);
  const result = await refreshCostCenters(range);
  assert.equal(result.purchases, 1);
  assert.equal(result.payables, 1);
  const purchase = await PurchaseInvoice.findOne({ sourceRef: record }).lean();
  assert.equal(String(purchase.costCenter), String(ccLab));
  assert.deepEqual(purchase.items.map((item) => String(item.costCenter)), [String(ccLab), String(ccLab)]);
  assert.equal(String((await Payable.findOne({ sourceRef: record }).lean()).costCenter), String(ccLab));
  // Idempotente: una segunda pasada no cambia nada.
  const again = await refreshCostCenters(range);
  assert.deepEqual([again.purchases, again.payables], [0, 0]);
});
