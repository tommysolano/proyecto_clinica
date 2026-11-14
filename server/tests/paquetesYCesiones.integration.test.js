/**
 * PAQUETES DE SESIONES, APLICAR UNA PARTE HOY Y CEDER A OTRO PACIENTE (nov-2026).
 *
 *  · «2 DETOX PLUS» (servicio con paquete 2 × DETOX PLUS) deja 2 sesiones de DETOX PLUS.
 *  · «NEURO REGENERADOR» (compuesto 2 × ampolla) que lo deja en la clínica con 1 aplicada
 *    hoy: sale 1 ampolla con la venta y queda 1 ampolla a su nombre.
 *  · Lo guardado y las sesiones libres se pueden ceder a otro paciente.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Product = require('../models/Product');
const Patient = require('../models/Patient');
const PatientItem = require('../models/PatientItem');
const PrepaidService = require('../models/PrepaidService');
const sales = require('../controllers/saleController');
const patients = require('../controllers/patientController');
const products = require('../controllers/productController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const stock = async (p) => (await Product.findById(p._id)).stock;

async function escenario() {
  const { clinicId, userId } = await H.seedClinic();
  const ana = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Paz', cedula: '0102030405', phone: '0990000001' });
  const luis = await Patient.create({ clinic: clinicId, firstName: 'Luis', lastName: 'Mora', cedula: '0911111111', phone: '0990000002' });
  const cobrar = (body) => H.runController(sales.createSale, H.mockReq(clinicId, userId, {
    paymentMethod: 'efectivo', clientName: 'Ana Paz', clientCedula: '0102030405', patient: String(ana._id), ...body,
  }));
  const anular = (id) => H.runController(sales.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: String(id) } }));
  return { clinicId, userId, ana, luis, cobrar, anular };
}

test('un servicio con PAQUETE deja sus sesiones del servicio incluido', async () => {
  const { clinicId, userId, ana, cobrar } = await escenario();
  const detox = await H.makeProduct(clinicId, { name: 'DETOX PLUS', category: 'servicio', unlimited: true, price: 29, taxRate: 0, taxCategory: 'IVA_0' });
  const pack = await H.makeProduct(clinicId, { name: '2 DETOX PLUS', category: 'servicio', unlimited: true, price: 39, taxRate: 0, taxCategory: 'IVA_0' });
  const upd = await H.runController(products.updateProduct, H.mockReq(clinicId, userId, {
    packageSessions: [{ product: String(detox._id), quantity: 2 }],
  }, { params: { id: String(pack._id) } }));
  assert.equal(upd.statusCode, 200, JSON.stringify(upd.payload));

  const r = await cobrar({ items: [{ product: String(pack._id), quantity: 1 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.total, 39);
  const [paq] = await PrepaidService.find({ patient: ana._id });
  assert.equal(String(paq.product), String(detox._id), 'las sesiones son del servicio incluido');
  assert.equal(paq.quantity, 2);
});

test('el paquete solo admite servicios', async () => {
  const { clinicId, userId } = await escenario();
  const insumo = await H.makeProduct(clinicId, { name: 'GUANTES', stock: 5 });
  const pack = await H.makeProduct(clinicId, { name: 'PAQ', category: 'servicio', unlimited: true, price: 10 });
  const r = await H.runController(products.updateProduct, H.mockReq(clinicId, userId, {
    packageSessions: [{ product: String(insumo._id), quantity: 2 }],
  }, { params: { id: String(pack._id) } }));
  assert.equal(r.statusCode, 400);
});

test('ceder sesiones libres a otro paciente', async () => {
  const { clinicId, userId, ana, luis, cobrar } = await escenario();
  const detox = await H.makeProduct(clinicId, { name: 'DETOX PLUS', category: 'servicio', unlimited: true, price: 29, taxRate: 0, taxCategory: 'IVA_0' });
  const r = await cobrar({ items: [{ product: String(detox._id), quantity: 2, prepaid: true }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const [paq] = await PrepaidService.find({ patient: ana._id });

  const ceder = (body) => H.runController(patients.transferPrepaid, H.mockReq(clinicId, userId, body, {
    params: { id: String(ana._id), packageId: String(paq._id) },
  }));
  assert.equal((await ceder({ toPatient: String(luis._id), quantity: 1 })).statusCode, 400, 'sin motivo no');
  assert.equal((await ceder({ toPatient: String(luis._id), quantity: 3, reason: 'familia' })).statusCode, 400, 'no más de las libres');
  const ok = await ceder({ toPatient: String(luis._id), quantity: 1, reason: 'Se la regala a su esposo' });
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));
  assert.equal((await PrepaidService.findById(paq._id)).quantity, 1);
  const [deLuis] = await PrepaidService.find({ patient: luis._id });
  assert.equal(deLuis.quantity, 1);
  assert.equal(String(deLuis.product), String(detox._id));
  assert.equal(String(deLuis.transferredFrom.patient), String(ana._id));
  assert.match(ok.payload[0].cesiones[0].a, /luis mora/i);
});

test('compuesto 2 × ampolla: lo deja en la clínica con 1 aplicada hoy; anular devuelve todo', async () => {
  const { clinicId, ana, cobrar, anular } = await escenario();
  const ampolla = await H.makeProduct(clinicId, { name: 'TRIPTOFANO 10 ML ROCAB', stock: 10, price: 20, averageCost: 3 });
  const neuro = await H.makeProduct(clinicId, { name: 'NEURO REGENERADOR ROCAB', stock: 0, price: 45 });
  await Product.updateOne({ _id: neuro._id }, { isComposite: true, composition: [{ product: ampolla._id, quantity: 2 }] });

  const r = await cobrar({ items: [{ product: String(neuro._id), quantity: 1, delivery: 'en_clinica', appliedNow: 1 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.total, 45);
  assert.equal(await stock(ampolla), 9, 'sale la ampolla de hoy');
  const [guardado] = await PatientItem.find({ patient: ana._id });
  assert.equal(String(guardado.product), String(ampolla._id), 'se guarda como ampollas');
  assert.equal(guardado.quantity, 2);
  assert.equal(guardado.remaining, 1);

  const a = await anular(r.payload._id);
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  assert.equal(await stock(ampolla), 10, 'vuelve la ampolla de hoy');
  assert.equal((await PatientItem.findById(guardado._id)).status, 'anulado');
});

test('producto normal ×2: 1 hoy y 1 guardada; aplicar después y ceder', async () => {
  const { clinicId, userId, ana, luis, cobrar } = await escenario();
  const amp = await H.makeProduct(clinicId, { name: 'VITAMINA C AMPOLLA', stock: 10, price: 8, averageCost: 2 });
  const r = await cobrar({ items: [{ product: String(amp._id), quantity: 3, delivery: 'en_clinica', appliedNow: 1 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(amp), 9);
  const [g] = await PatientItem.find({ patient: ana._id });
  assert.equal(g.remaining, 2);

  const ceder = await H.runController(patients.transferPatientItem, H.mockReq(clinicId, userId, {
    toPatient: String(luis._id), quantity: 1, reason: 'Se la pasa a su hijo',
  }, { params: { id: String(ana._id), itemId: String(g._id) } }));
  assert.equal(ceder.statusCode, 200, JSON.stringify(ceder.payload));
  assert.equal((await PatientItem.findById(g._id)).remaining, 1);
  const [deLuis] = await PatientItem.find({ patient: luis._id });
  assert.equal(deLuis.remaining, 1);
  assert.equal(await stock(amp), 9, 'ceder no mueve el inventario');

  const ap = await H.runController(patients.applyPatientItem, H.mockReq(clinicId, userId, { quantity: 1 }, {
    params: { id: String(luis._id), itemId: String(deLuis._id) },
  }));
  assert.equal(ap.statusCode, 200, JSON.stringify(ap.payload));
  assert.equal(await stock(amp), 8, 'sale al aplicársela a quien la recibió');
});

test('si se aplica todo hoy, es «se lo aplica aquí»', async () => {
  const { clinicId, ana, cobrar } = await escenario();
  const amp = await H.makeProduct(clinicId, { name: 'ZINC', stock: 10, price: 8 });
  const r = await cobrar({ items: [{ product: String(amp._id), quantity: 2, delivery: 'en_clinica', appliedNow: 2 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(amp), 8);
  assert.equal(await PatientItem.countDocuments({ patient: ana._id }), 0);
});
