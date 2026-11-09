const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const Discount = require('../models/Discount');
const Clinic = require('../models/Clinic');
const Company = require('../models/Company');
const Patient = require('../models/Patient');
const Sale = require('../models/Sale');
const sales = require('../controllers/saleController');
const { calculateDiscounts } = require('../services/saleDiscounts');

test.before(async () => H.startDb());
test.after(async () => H.stopDb());
test.beforeEach(async () => H.resetDb());

async function setup() {
  const { clinicId, userId } = await H.seedClinic();
  const company = await Company.create({ name: 'Empresa' });
  await Clinic.create({ _id: clinicId, name: 'Laboratorio', company: company._id });
  const central = await Clinic.create({ name: 'Central', company: company._id });
  const product = await H.makeProduct(clinicId, { name: 'Servicio', category: 'servicio', unlimited: true, salePrice: 100, taxCategory: 'IVA_0', taxRate: 0 });
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', birthDate: new Date('1990-11-09T00:00:00Z') });
  const items = [{ product: product._id, quantity: 1, unitPrice: 100 }];
  const calc = (extra = {}) => calculateDiscounts({ clinicId, patientId: patient._id, items,
    products: new Map([[String(product._id), product]]), priceOf: (_, item) => item.unitPrice,
    now: new Date('2026-11-09T15:00:00Z'), ...extra });
  return { clinicId, userId, central, product, patient, items, calc };
}

test('suma reglas de la empresa y respeta productos, fechas, días, hora, audiencia y mínimo', async () => {
  const s = await setup();
  const regla = { clinic: s.central._id, name: 'Promoción', type: 'percentage', value: 10, scope: 'specific', products: [s.product._id],
    startDate: new Date('2026-11-09'), endDate: new Date('2026-11-09'), daysOfWeek: [1], startTime: '09:00', endTime: '10:00',
    clinics: [s.clinicId], audience: 'cumpleanos', minAmount: 100 };
  await Discount.create(regla);
  await Discount.create({ clinic: s.clinicId, name: 'Fijo', type: 'amount', value: 5, scope: 'all', audience: 'nuevos' });
  const [aplicado] = await s.calc();
  assert.equal(aplicado.discount, 15);
  assert.equal(aplicado.applied.length, 2);
  assert.equal((await s.calc({ now: new Date('2026-11-09T16:00:00Z') }))[0].discount, 5);
  assert.equal((await s.calc({ patientId: null }))[0].discount, 0);
  assert.equal((await s.calc({ now: new Date('2026-11-10T15:00:00Z') }))[0].discount, 5);
  await Sale.collection.insertOne({ clinic: s.clinicId, patient: s.patient._id, status: 'completada' });
  assert.equal((await s.calc())[0].discount, 10, 'una venta anterior descarta la regla para pacientes nuevos');
});

test('la venta confirma descuentos, cuenta usos una vez y los libera al anular', async () => {
  const s = await setup();
  const r1 = await Discount.create({ clinic: s.central._id, name: 'Diez', type: 'percentage', value: 10, scope: 'all', maxUses: 1 });
  const r2 = await Discount.create({ clinic: s.clinicId, name: 'Cinco', type: 'amount', value: 5, scope: 'all' });
  const body = { items: s.items, paymentMethod: 'efectivo', discountPreview: [15] };
  const response = await H.runController(sales.createSale, H.mockReq(s.clinicId, s.userId, body));
  assert.equal(response.statusCode, 201, JSON.stringify(response.payload));
  const sale = await Sale.findById(response.payload._id);
  assert.equal(sale.total, 85);
  assert.equal(sale.items[0].discount, 15);
  assert.equal(sale.items[0].discountTaxBase, 15);
  assert.equal(sale.items[0].discountRefs.length, 2);
  const { factura } = require('../controllers/invoiceController')._armarFactura({ sale, config: {}, clinic: null,
    serie: { estab: '001', ptoEmi: '001', ambiente: '1' }, secuencial: '000000001', claveAcceso: '', fechaEmision: new Date() });
  assert.equal(factura.detalles[0].descuento, 15);
  assert.equal(factura.infoFactura.totalDescuento, 15);
  assert.equal(factura.infoFactura.importeTotal, 85);
  assert.equal((await Discount.findById(r1._id)).usedCount, 1);
  assert.equal((await Discount.findById(r2._id)).usedCount, 1);
  const stale = await H.runController(sales.createSale, H.mockReq(s.clinicId, s.userId, body));
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.payload.code, 'DISCOUNT_CHANGED');
  const cancelled = await H.runController(sales.cancelSale, H.mockReq(s.clinicId, s.userId, {}, { params: { id: String(sale._id) } }));
  assert.equal(cancelled.statusCode, 200, JSON.stringify(cancelled.payload));
  assert.equal((await Discount.findById(r1._id)).usedCount, 0);
  assert.equal((await Discount.findById(r2._id)).usedCount, 0);
});

test('un descuento total se limita al valor de la línea y permite contabilizar sin pago', async () => {
  const s = await setup();
  await Discount.create({ clinic: s.clinicId, name: 'Total', type: 'percentage', value: 100, scope: 'all' });
  await Discount.create({ clinic: s.clinicId, name: 'Extra', type: 'amount', value: 50, scope: 'all' });
  const preview = await H.runController(sales.previewDiscounts, H.mockReq(s.clinicId, s.userId, { items: s.items }));
  assert.equal(preview.payload.items[0].discount, 100);
  assert.equal(preview.payload.items[0].applied.length, 1);
  const result = await H.runController(sales.createSale, H.mockReq(s.clinicId, s.userId, {
    items: s.items, discountPreview: [100],
  }));
  assert.equal(result.statusCode, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.total, 0);
  assert.ok((await H.assertLedgerBalanced(s.clinicId)).balanced);
});

test('los límites y reglas de otra empresa no conceden descuentos', async () => {
  const s = await setup();
  const foreignCompany = await Company.create({ name: 'Ajena' });
  const foreignClinic = await Clinic.create({ name: 'Ajena', company: foreignCompany._id });
  await Discount.create({ clinic: foreignClinic._id, name: 'Ajeno', type: 'percentage', value: 40, scope: 'all' });
  await Discount.create({ clinic: s.clinicId, name: 'Agotado', type: 'percentage', value: 20, scope: 'all', maxUses: 1, usedCount: 1 });
  await Discount.create({ clinic: s.clinicId, name: 'Mínimo', type: 'percentage', value: 20, scope: 'all', minAmount: 101 });
  await Discount.create({ clinic: s.clinicId, name: 'Otra sede', type: 'percentage', value: 20, scope: 'all', clinics: [s.central._id] });
  assert.equal((await s.calc())[0].discount, 0);
});

test('dos ventas simultáneas no pueden usar el último cupo', async () => {
  const s = await setup();
  const rule = await Discount.create({ clinic: s.clinicId, name: 'Último cupo', type: 'percentage', value: 10, scope: 'all', maxUses: 1 });
  const makeRequest = () => H.runController(sales.createSale, H.mockReq(s.clinicId, s.userId, {
    items: s.items, paymentMethod: 'efectivo', discountPreview: [10],
  }));
  const results = await Promise.all([makeRequest(), makeRequest()]);
  assert.deepEqual(results.map((r) => r.statusCode).sort(), [201, 409]);
  assert.equal((await Discount.findById(rule._id)).usedCount, 1);
  assert.equal(await Sale.countDocuments({ clinic: s.clinicId, status: 'completada' }), 1);
});
