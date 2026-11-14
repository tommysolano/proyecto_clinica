/**
 * ÍTEMS VINCULADOS E ÍTEMS DEL PACIENTE (oct-2026).
 *
 * Al cobrar «Sueroterapia» salen SOLOS del inventario los ítems de su ficha
 * (cantidad × unidades vendidas) y no suman al precio: quien cobra no escoge nada. Lo que el paciente compra y NO se lleva no sale
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
const products = require('../controllers/productController');

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

test('los vinculados salen SOLOS del inventario al cobrar (cantidad × unidades) y no suman al precio; anular los devuelve', async () => {
  const { suero, vitC, zinc, cobrar, anular, clinicId } = await escenario();
  await Product.updateOne({ _id: suero._id }, { linkedItems: [{ product: vitC._id, quantity: 2 }, { product: zinc._id, quantity: 1 }] });
  // Quien cobra solo escoge el servicio: no manda nada de vinculados.
  const r = await cobrar({ items: [{ product: String(suero._id), quantity: 1 }] });
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

test('dos unidades del servicio descuentan el doble', async () => {
  const { suero, vitC, zinc, cobrar } = await escenario();
  const r = await cobrar({ items: [{ product: String(suero._id), quantity: 2 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(vitC), 8);
  assert.equal(await stock(zinc), 8);
});

test('lo que mande el navegador como vinculado se ignora: manda la ficha del producto', async () => {
  const { suero, vitC, zinc, cobrar, clinicId } = await escenario();
  const otro = await H.makeProduct(clinicId, { name: 'OTRA COSA', stock: 5 });
  const r = await cobrar({ items: [{ product: String(suero._id), quantity: 1, linkedItems: [{ product: String(otro._id), quantity: 3 }] }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(otro), 5, 'no se toca lo que no está en la ficha');
  assert.equal(await stock(vitC), 9);
  assert.equal(await stock(zinc), 9);
});

test('un vinculado que ya no existe no frena el cobro', async () => {
  const { suero, vitC, zinc, cobrar } = await escenario();
  await Product.deleteOne({ _id: zinc._id });
  const r = await cobrar({ items: [{ product: String(suero._id), quantity: 1 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(vitC), 9);
});

test('componentes por categoría: hasta tres unidades incluidas, costo de inventario y anulación', async () => {
  const { clinicId, userId, suero, vitC, zinc, cobrar, anular } = await escenario();
  const cat = vitC.inventoryCategory;
  const updated = await H.runController(products.updateProduct, H.mockReq(clinicId, userId, {
    salePrices: [{ name: 'General', price: 29, active: true }],
    includedComponents: { enabled: true, maxQuantity: 3, categories: [String(cat)] },
  }, { params: { id: String(suero._id) } }));
  assert.equal(updated.statusCode, 200, JSON.stringify(updated.payload));
  const result = await cobrar({ items: [{ product: String(suero._id), quantity: 1, linkedItems: [
    { product: String(vitC._id), quantity: 2 }, { product: String(zinc._id), quantity: 1 },
  ] }] });
  assert.equal(result.statusCode, 201, JSON.stringify(result.payload));
  assert.equal(result.payload.total, 29);
  assert.equal(await stock(vitC), 8);
  assert.equal(await stock(zinc), 9);
  const sale = await Sale.findById(result.payload._id);
  assert.equal(sale.items[0].linkedItems.length, 2);
  assert.ok(sale.costJournalEntry);
  assert.equal((await anular(result.payload._id)).statusCode, 200);
  assert.equal(await stock(vitC), 10);
  assert.equal(await stock(zinc), 10);
});

test('componentes por categoría: valida límite, unidades y categorías desde el servidor', async () => {
  const { clinicId, suero, vitC, zinc, cobrar } = await escenario();
  const InventoryCategory = require('../models/InventoryCategory');
  const otherCat = await InventoryCategory.create({ clinic: clinicId, code: 'OTRA', name: 'Otra', kind: 'INVENTARIO' });
  const otro = await H.makeProduct(clinicId, { inventoryCategory: otherCat._id, stock: 5 });
  await Product.updateOne({ _id: suero._id }, { includedComponents: { enabled: true, maxQuantity: 3, categories: [vitC.inventoryCategory] } });
  const request = (linkedItems, quantity = 1) => cobrar({ items: [{ product: String(suero._id), quantity, linkedItems }] });
  assert.equal((await request([{ product: String(vitC._id), quantity: 4 }])).statusCode, 400);
  assert.equal((await request([{ product: String(vitC._id), quantity: 2 }, { product: String(zinc._id), quantity: 2 }])).statusCode, 400);
  assert.equal((await request([{ product: String(vitC._id), quantity: 2 }, { product: String(vitC._id), quantity: 2 }])).statusCode, 400);
  assert.equal((await request([{ product: String(vitC._id), quantity: 1.5 }])).statusCode, 400);
  assert.equal((await request([{ product: String(otro._id), quantity: 1 }])).statusCode, 400);
  await Product.updateOne({ _id: vitC._id }, { disabled: true });
  assert.equal((await request([{ product: String(vitC._id), quantity: 1 }])).statusCode, 400);
  await Product.updateOne({ _id: vitC._id }, { disabled: false });
  assert.equal((await request([{ product: String(vitC._id), quantity: 6 }], 2)).statusCode, 201);
  assert.equal((await request([])).statusCode, 201);
});

test('la configuración de componentes rechaza categorías y límites inválidos', async () => {
  const { clinicId, userId, suero, vitC } = await escenario();
  const update = (config) => H.runController(products.updateProduct, H.mockReq(clinicId, userId,
    { includedComponents: config }, { params: { id: String(suero._id) } }));
  assert.equal((await update({ enabled: true, maxQuantity: 0, categories: [String(vitC.inventoryCategory)] })).statusCode, 400);
  assert.equal((await update({ enabled: true, maxQuantity: 3, categories: [String(new mongoose.Types.ObjectId())] })).statusCode, 400);
  assert.equal((await update({ enabled: true, maxQuantity: 3, categories: [String(vitC.inventoryCategory)] })).statusCode, 200);
});

test('sin stock suficiente avisa pero deja cobrar', async () => {
  const { suero, vitC, zinc, cobrar } = await escenario();
  await Product.updateOne({ _id: vitC._id }, { stock: 1 });
  await Product.updateOne({ _id: suero._id }, { linkedItems: [{ product: vitC._id, quantity: 3 }, { product: zinc._id, quantity: 1 }] });
  const r = await cobrar({ items: [{ product: String(suero._id), quantity: 1 }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(vitC), 0);
  assert.ok((r.payload.warnings || []).some((w) => /VITAMINA C/.test(w)), 'avisa del stock corto');
  const venta = await Sale.findById(r.payload._id);
  assert.equal(venta.items[0].linkedItems.find((l) => String(l.product) === String(vitC._id)).stockMoved, 1, 'anota lo que de verdad bajó');
});

test('lo comprado que NO se lleva no sale del inventario y queda a nombre del paciente', async () => {
  const { vitC, patient, cobrar, anular } = await escenario();
  const compra = await cobrar({ patient, items: [{ product: String(vitC._id), quantity: 3, delivery: 'en_clinica' }] });
  assert.equal(compra.statusCode, 201, JSON.stringify(compra.payload));
  assert.equal(compra.payload.total, 24, 'las ampollas sí se cobran');
  assert.equal(await stock(vitC), 10, 'no sale del inventario al comprarlas');
  const [guardado] = await PatientItem.find({ patient });
  assert.equal(guardado.mode, 'en_clinica');
  assert.equal(guardado.remaining, 3);
  const a = await anular(compra.payload._id);
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  assert.equal(await stock(vitC), 10, 'no devuelve stock que nunca salió');
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

test('«se lo aplica aquí» sale del inventario hoy y no deja nada guardado', async () => {
  const { vitC, patient, cobrar } = await escenario();
  const r = await cobrar({ patient, items: [{ product: String(vitC._id), quantity: 2, delivery: 'aplicado' }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(vitC), 8);
  assert.equal(await PatientItem.countDocuments({ patient }), 0);
  assert.equal((await Sale.findById(r.payload._id)).items[0].delivery, 'aplicado');
});

test('un COMPUESTO que lo deja en la clínica no mueve nada hoy; al aplicarlo salen sus componentes', async () => {
  const { clinicId, userId, patient, cobrar, anular } = await escenario();
  const frasco = await H.makeProduct(clinicId, { name: 'TRIPTOFANO 10 ML NOVA', stock: 10, price: 20, averageCost: 3 });
  const neuro = await H.makeProduct(clinicId, { name: 'NEURO REGENERADOR 20ML', stock: 0, price: 45 });
  await Product.updateOne({ _id: neuro._id }, { isComposite: true, composition: [{ product: frasco._id, quantity: 2 }] });

  const r = await cobrar({ patient, items: [{ product: String(neuro._id), quantity: 1, delivery: 'en_clinica' }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.total, 45, 'se factura');
  assert.equal(await stock(frasco), 10, 'hoy no sale nada');
  const [guardado] = await PatientItem.find({ patient });
  assert.equal(guardado.mode, 'en_clinica');

  assert.equal(guardado.remaining, 2, 'se guarda como sus 2 ampollas');
  const req = H.mockReq(clinicId, userId, { quantity: 2 }, { params: { id: patient, itemId: String(guardado._id) } });
  const ap = await H.runController(patients.applyPatientItem, req);
  assert.equal(ap.statusCode, 200, JSON.stringify(ap.payload));
  assert.equal(await stock(frasco), 8, 'al aplicarlo salen sus componentes');
  assert.equal(await stock(neuro), 0);

  // Ya aplicado: la venta no se puede anular.
  assert.equal((await anular(r.payload._id)).statusCode, 409);
});

test('un COMPUESTO que se lleva o se aplica hoy saca sus componentes al cobrar', async () => {
  const { clinicId, patient, cobrar } = await escenario();
  const frasco = await H.makeProduct(clinicId, { name: 'DMSO PLUS 50ML', stock: 10, price: 30, averageCost: 3 });
  const chico = await H.makeProduct(clinicId, { name: 'DMSO PLUS 10ML', stock: 0, price: 10 });
  await Product.updateOne({ _id: chico._id }, { isComposite: true, composition: [{ product: frasco._id, quantity: 0.2 }] });
  const r = await cobrar({ patient, items: [{ product: String(chico._id), quantity: 5, delivery: 'aplicado' }] });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(await stock(frasco), 9);
});
