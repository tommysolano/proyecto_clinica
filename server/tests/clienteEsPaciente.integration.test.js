/**
 * CLIENTE = PACIENTE (nov-2026): facturar a la cédula —o al RUC cédula+001— de un paciente
 * sin haberlo elegido enlaza la venta a él. Consumidor Final y cédulas repetidas no.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const Patient = require('../models/Patient');
const sales = require('../controllers/saleController');
const { pacientePorCedula } = require('../utils/pacientePorCedula');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('pacientePorCedula: cédula, RUC 001, consumidor final y repetidos', async () => {
  const { clinicId } = await H.seedClinic();
  const p = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Paz', cedula: '0102030405', phone: '0990000001' });
  assert.equal(String(await pacientePorCedula('0102030405')), String(p._id));
  assert.equal(String(await pacientePorCedula('0102030405001')), String(p._id), 'RUC de persona natural');
  assert.equal(await pacientePorCedula('9999999999999'), null);
  assert.equal(await pacientePorCedula('ABC'), null);
  await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Duplicada', cedula: '0102030405', phone: '0990000002' });
  assert.equal(await pacientePorCedula('0102030405'), null, 'con dos pacientes no se adivina');
});

test('una venta sin paciente a la cédula/RUC de un paciente queda enlazada a él', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Paz', cedula: '0102030405', phone: '0990000001' });
  const prod = await H.makeProduct(clinicId, { name: 'Crema', stock: 5, price: 10 });
  const r = await H.runController(sales.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: String(prod._id), quantity: 1 }], paymentMethod: 'efectivo',
    clientName: 'ANA PAZ', clientCedula: '0102030405001',
  }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(String(r.payload.patient?._id || r.payload.patient), String(p._id));

  const cf = await H.runController(sales.createSale, H.mockReq(clinicId, userId, {
    items: [{ product: String(prod._id), quantity: 1 }], paymentMethod: 'efectivo',
    clientName: 'Consumidor Final', clientCedula: '9999999999999',
  }));
  assert.equal(cf.statusCode, 201, JSON.stringify(cf.payload));
  assert.ok(!cf.payload.patient, 'consumidor final no se enlaza');
});

test('el buscador de clientes no repite a quien ya es paciente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const Supplier = require('../models/Supplier');
  const suppliers = require('../controllers/supplierController');
  await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Paz', cedula: '0102030405', phone: '0990000001' });
  await Supplier.create({ clinic: clinicId, ruc: '0102030405001', razonSocial: 'ANA PAZ', roles: ['CLIENTE'] });
  await Supplier.create({ clinic: clinicId, ruc: '0999999999001', razonSocial: 'ANA EMPRESA SA', roles: ['CLIENTE'] });
  const r = await H.runController(suppliers.searchClients, H.mockReq(clinicId, userId, {}, { query: { q: 'ANA' } }));
  const nombres = r.payload.map((s) => s.razonSocial);
  assert.deepEqual(nombres, ['ANA EMPRESA SA'], 'la paciente sale solo como paciente');
});

test('el script enlaza las ventas viejas sin paciente a su paciente', async () => {
  const { clinicId } = await H.seedClinic();
  const Sale = require('../models/Sale');
  const p = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Paz', cedula: '0102030405', phone: '0990000001' });
  const base = { clinic: clinicId, items: [], total: 10, subtotal: 10, paymentMethod: 'efectivo' };
  const v1 = await Sale.collection.insertOne({ ...base, clientCedula: '0102030405001', clientName: 'ANA PAZ', patient: null });
  const v2 = await Sale.collection.insertOne({ ...base, clientCedula: '9999999999999', clientName: 'CF', patient: null });
  const { enlazar } = require('../scripts/enlazarVentasAPacienteOnce');
  const seco = await enlazar({ commit: false, log: () => {} });
  assert.equal(seco.enlazables, 1);
  assert.equal((await Sale.findById(v1.insertedId).lean()).patient, null, 'en seco no escribe');
  await enlazar({ commit: true, log: () => {} });
  assert.equal(String((await Sale.findById(v1.insertedId).lean()).patient), String(p._id));
  assert.equal((await Sale.findById(v2.insertedId).lean()).patient, null);
});
