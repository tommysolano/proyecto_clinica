/**
 * ÍTEMS VINCULADOS E ÍTEMS DEL PACIENTE (oct-2026).
 *
 * Al cobrar «Sueroterapia» se escogen las ampollas que lleva: salen del inventario
 * en el cobro y no suman al precio. Lo que el paciente compra y NO se lleva no sale
 * del inventario y queda a su nombre hasta que se le aplica; lo que se lleva y luego
 * trae no se vuelve a descontar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const Product = require('../models/Product');
const Sale = require('../models/Sale');
const PatientItem = require('../models/PatientItem');
const sales = require('../controllers/saleController');
const patients = require('../controllers/patientController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const stock = async (p) => (await Product.findById(p._id)).stock;

async function escenario() {
  const { clinicId, userId } = await H.seedClinic();
  const vitC = await H.makeProduct(clinicId, { name: 'VITAMINA C 10ML AMPOLLA', stock: 10, price: 8, averageCost: 2 });
  const zinc = await H.makeProduct(clinicId, { name: 'ZINC AMPOLLA', stock: 10, price: 6, averageCost: 1 });
  const suero = await H.makeProduct(clinicId, {
    name: 'SUEROTERAPIA', category: 'servicio', unlimited: true, price: 50, taxRate: 0, taxCategory: 'IVA_0',
    linkedItems: [{ product: vitC._id, quantity: 1 }, { product: zinc._id, quantity: 1 }],
  });
  const patient = String(new mongoose.Types.ObjectId());
  const cobrar = (body) => H.runController(sales.createSale, H.mockReq(clinicId, userId, { paymentMethod: 'efectivo', ...body }));
  const anular = (id) => H.runController(sales.cancelSale, H.mockReq(clinicId, userId, {}, { params: { id: String(id) } }));
  return { clinicId, userId, vitC, zinc, suero, patient, cobrar, anular };
}

test('los vinculados salen del inventario al cobrar y no suman al precio; anular los devuelve', async () => {
  const { suero, vitC, zinc, cobrar, anular, clinicId } = await escenario();
  const r = await cobrar({
    items: [{
      product: String(suero._id), quantity: 1,
      linkedItems: [{ product: String(vitC._id), quantity: 2 }, { product: String(zinc._id), quantity: 1 }],
    }],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.total, 50, 'solo se cobra el servicio');
  assert.equal(await stock(vitC), 8);
  assert.equal(await stock(zinc), 9);
  const venta = await Sale.findById(r.payload._id);
  assert.equal(venta.items[0].linkedItems.length, 2);
  assert.equal(venta.items[0].linkedItems[0].stockMoved, 2);
  assert.ok(venta.costJournalEntry, 'el costo de las ampollas va en el asiento de costo');
  assert.ok((await H.assertLedgerBalanced(clinicId)).balanced);

  const a = await anular(r.payload._id);
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  assert.equal(await stock(vitC), 10);
  assert.equal(await stock(zinc), 10);
});

test('con precio variable se cobra el importe tecleado del servicio, y los vinculados siguen sin sumar', async () => {
  const { suero, vitC, cobrar } = await escenario();
  await Product.updateOne({ _id: suero._id }, { variablePrice: true });
  const r = await cobrar({
    items: [{ product: String(suero._id), quantity: 1, unitPrice: 75, linkedItems: [{ product: String(vitC._id), quantity: 1 }] }],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.total, 75);
  assert.equal(await stock(vitC), 9);
});

test('un ítem que no está vinculado al producto se rechaza', async () => {
  const { suero, cobrar, clinicId } = await escenario();
  const otro = await H.makeProduct(clinicId, { name: 'OTRA COSA', stock: 5 });
  const r = await cobrar({ items: [{ product: String(suero._id), quantity: 1, linkedItems: [{ product: String(otro._id), quantity: 1 }] }] });
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no está vinculado/);
  assert.equal(await stock(otro), 5);
});

test('sin stock suficiente avisa pero deja cobrar', async () => {
  const { suero, vitC, cobrar } = await escenario();
  await Product.updateOne({ _id: vitC._id }, { stock: 1 });
  const r = await cobrar({ items: [{ product: String(suero._id), quantity: 1, linkedItems: [{ product: String(vitC._id), quantity: 3 }] }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(vitC), 0);
  assert.ok((r.payload.warnings || []).some((w) => /VITAMINA C/.test(w)), 'avisa del stock corto');
  const venta = await Sale.findById(r.payload._id);
  assert.equal(venta.items[0].linkedItems[0].stockMoved, 1, 'anota lo que de verdad bajó');
});

test('lo comprado que NO se lleva no sale del inventario; sale cuando se le aplica en el servicio', async () => {
  const { suero, vitC, patient, cobrar, anular } = await escenario();
  const compra = await cobrar({ patient, items: [{ product: String(vitC._id), quantity: 3, delivery: 'en_clinica' }] });
  assert.equal(compra.statusCode, 201, JSON.stringify(compra.payload));
  assert.equal(compra.payload.total, 24, 'las ampollas sí se cobran');
  assert.equal(await stock(vitC), 10, 'no sale del inventario al comprarlas');
  const [guardado] = await PatientItem.find({ patient });
  assert.equal(guardado.mode, 'en_clinica');
  assert.equal(guardado.remaining, 3);

  const servicio = await cobrar({
    patient,
    items: [{ product: String(suero._id), quantity: 1, linkedItems: [{ product: String(vitC._id), quantity: 2, source: 'paciente' }] }],
  });
  assert.equal(servicio.statusCode, 201, JSON.stringify(servicio.payload));
  assert.equal(servicio.payload.total, 50, 'las suyas no se cobran otra vez');
  assert.equal(await stock(vitC), 8, 'salen del inventario al aplicarlas');
  assert.equal((await PatientItem.findById(guardado._id)).remaining, 1);

  // La compra ya se usó: no se puede anular. Anular el servicio las devuelve al paciente.
  const a1 = await anular(compra.payload._id);
  assert.equal(a1.statusCode, 409, JSON.stringify(a1.payload));
  const a2 = await anular(servicio.payload._id);
  assert.equal(a2.statusCode, 200, JSON.stringify(a2.payload));
  assert.equal(await stock(vitC), 10);
  assert.equal((await PatientItem.findById(guardado._id)).remaining, 3);
  // Ahora sí se anula la compra, y no devuelve stock que nunca salió.
  const a3 = await anular(compra.payload._id);
  assert.equal(a3.statusCode, 200, JSON.stringify(a3.payload));
  assert.equal(await stock(vitC), 10);
  assert.equal((await PatientItem.findById(guardado._id)).status, 'anulado');
});

test('no alcanza lo guardado del paciente → 400 y nada se mueve', async () => {
  const { suero, vitC, patient, cobrar } = await escenario();
  await cobrar({ patient, items: [{ product: String(vitC._id), quantity: 1, delivery: 'en_clinica' }] });
  const r = await cobrar({
    patient,
    items: [{ product: String(suero._id), quantity: 1, linkedItems: [{ product: String(vitC._id), quantity: 2, source: 'paciente' }] }],
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no alcanza/);
  assert.equal(await stock(vitC), 10);
});

test('lo que se llevó y TRAJO no se descuenta otra vez', async () => {
  const { suero, vitC, patient, cobrar } = await escenario();
  const compra = await cobrar({ patient, items: [{ product: String(vitC._id), quantity: 2, delivery: 'llevado' }] });
  assert.equal(compra.statusCode, 201, JSON.stringify(compra.payload));
  assert.equal(await stock(vitC), 8, 'se lo llevó: sale al venderlo');
  const [llevado] = await PatientItem.find({ patient });
  assert.equal(llevado.mode, 'llevado', 'queda anotado porque es ítem vinculado de un servicio');

  const r = await cobrar({
    patient,
    items: [{ product: String(suero._id), quantity: 1, linkedItems: [{ product: String(vitC._id), quantity: 2, source: 'trajo' }] }],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(vitC), 8, 'no se descuenta lo que trajo');
  assert.equal((await PatientItem.findById(llevado._id)).remaining, 0);
});

test('lo que se compra y se aplica en la MISMA venta sale una sola vez', async () => {
  const { suero, vitC, patient, cobrar } = await escenario();
  const r = await cobrar({
    patient,
    items: [
      { product: String(vitC._id), quantity: 2, delivery: 'en_clinica' },
      { product: String(suero._id), quantity: 1, linkedItems: [{ product: String(vitC._id), quantity: 2, source: 'paciente' }] },
    ],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.total, 66);
  assert.equal(await stock(vitC), 8);
  assert.equal((await PatientItem.findOne({ patient })).remaining, 0);
});

test('aplicar desde el perfil saca del inventario lo que dejó guardado', async () => {
  const { vitC, patient, cobrar, clinicId, userId } = await escenario();
  await cobrar({ patient, items: [{ product: String(vitC._id), quantity: 3, delivery: 'en_clinica' }] });
  const [guardado] = await PatientItem.find({ patient });
  const req = H.mockReq(clinicId, userId, { quantity: 2 }, {
    params: { id: patient, itemId: String(guardado._id) }, role: 'enfermero',
  });
  req.user.clinics = [{ clinic: clinicId }]; // enfermería ve su sucursal
  const r = await H.runController(patients.applyPatientItem, req);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(await stock(vitC), 8);
  assert.equal(r.payload.items[0].remaining, 1);
  const demas = await H.runController(patients.applyPatientItem, H.mockReq(clinicId, userId, { quantity: 5 }, {
    params: { id: patient, itemId: String(guardado._id) },
  }));
  assert.equal(demas.statusCode, 400);
});

test('dejarlo en la clínica sin paciente se rechaza', async () => {
  const { vitC, cobrar } = await escenario();
  const r = await cobrar({ items: [{ product: String(vitC._id), quantity: 1, delivery: 'en_clinica' }] });
  assert.equal(r.statusCode, 400);
  assert.equal(await stock(vitC), 10);
});
