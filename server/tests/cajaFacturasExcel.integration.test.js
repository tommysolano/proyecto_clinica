const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');
const Clinic = require('../models/Clinic');
const User = require('../models/User');
const Sale = require('../models/Sale');
const Invoice = require('../models/Invoice');
const CashClosing = require('../models/CashClosing');
const controller = require('../controllers/cashClosingController');

test.before(async () => H.startDb());
test.after(async () => H.stopDb());
test.beforeEach(async () => H.resetDb());

async function excel(req) {
  const stream = new PassThrough();
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  stream.setHeader = () => {};
  stream.status = (code) => { stream.statusCode = code; return stream; };
  stream.json = (body) => { stream.payload = body; stream.end(); return stream; };
  const done = new Promise((resolve, reject) => { stream.on('end', resolve); stream.on('error', reject); });
  await controller.invoicesExcel(req, stream);
  await done;
  if (stream.statusCode) return { status: stream.statusCode, payload: stream.payload };
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.concat(chunks));
  return { status: 200, sheet: wb.getWorksheet('Facturas') };
}

test('Excel incluye las facturas de cajas sumadas una sola vez y respeta el acceso a la caja', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Principal' });
  const user = await User.create({ name: 'Contable', email: 'caja-excel@example.com', password: 'clave123', clinics: [{ clinic: clinicId, role: 'contabilidad' }] });
  const start = new Date(Date.now() - 60000);
  const box = () => CashClosing.create({ clinic: clinicId, date: start, openedAt: start, openedBy: userId, status: 'ABIERTA' });
  const caja1 = await box();
  const caja2 = await box();
  for (const [n, state] of [[1, 'AUTORIZADO'], [2, 'ANULADA']]) {
    const saleId = new H.mongoose.Types.ObjectId();
    const invoiceId = new H.mongoose.Types.ObjectId();
    await Invoice.collection.insertOne({ _id: invoiceId, clinic: clinicId, sale: saleId, claveAcceso: `clave-${n}`, estab: '001', ptoEmi: '001', secuencial: String(n), estado: state });
    await Sale.collection.insertOne({ _id: saleId, clinic: clinicId, invoice: invoiceId, status: n === 2 ? 'anulada' : 'completada',
      saleNumber: `V-${n}`, total: 10, subtotal: 10, taxAmount: 0, createdAt: new Date(), items: [], paymentMethod: 'efectivo' });
  }
  await Sale.collection.insertOne({ clinic: clinicId, status: 'completada', saleNumber: 'SIN-FACTURA', total: 8,
    subtotal: 8, taxAmount: 0, createdAt: new Date(), items: [], paymentMethod: 'efectivo' });
  const req = Object.assign(H.mockReq(clinicId, user._id, {}, { role: 'contabilidad', params: { id: String(caja1._id) }, query: { add: String(caja2._id) } }), { user });
  const result = await excel(req);
  assert.equal(result.status, 200);
  const rows = [];
  result.sheet.eachRow((row) => { if (String(row.getCell(4).value || '').startsWith('001-001-')) rows.push(row); });
  assert.deepEqual(rows.map((row) => row.getCell(4).value).sort(), ['001-001-000000001', '001-001-000000002']);
  assert.ok(rows.some((row) => row.getCell(5).value === 'ANULADA'));
  const cashier = await User.create({ name: 'Cajero', email: 'caja-restriccion@example.com', password: 'clave123', clinics: [{ clinic: clinicId, role: 'cajero' }] });
  const blocked = Object.assign(H.mockReq(clinicId, cashier._id, {}, { role: 'cajero', params: { id: String(caja1._id) } }), { user: cashier });
  assert.equal((await excel(blocked)).status, 403);
});

test('cajero no puede acceder a las API de liquidaciones ni lotes', () => {
  for (const router of [require('../routes/cardSettlements'), require('../routes/creditCardBatches')]) {
    const guard = router.stack[2].handle;
    let status;
    guard({ role: 'cajero', user: {} }, { status(code) { status = code; return this; }, json() {} }, () => { status = 200; });
    assert.equal(status, 403);
  }
});
