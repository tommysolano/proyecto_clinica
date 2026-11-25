process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

/**
 * COMISIÓN POR PORCENTAJE EN UNA VISITA DE VARIOS SERVICIOS (nov-2026).
 *
 * El porcentaje de la tarifa de un servicio va sobre lo pagado por ESE servicio, no sobre
 * toda la visita. Caso real (Dra. Rosi, 19-10): «ECO 360 ($1,50 fijo) + Consulta por
 * seguimiento (30 %)» por $23 pagaba 30 % × $23 = $6,90 por la consulta.
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const User = require('../models/User');
const Sale = require('../models/Sale');
const PrepaidService = require('../models/PrepaidService');
const CommissionPrepaidAllocation = require('../models/CommissionPrepaidAllocation');
const CommissionBaseOverride = require('../models/CommissionBaseOverride');
const CommissionRule = require('../models/CommissionRule');
const ctrl = require('../controllers/commissionController');

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await CommissionRule.syncIndexes();
});
test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
test.beforeEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

async function escenario() {
  const sede = await Clinic.create({ name: 'Matriz', nombreComercial: 'Matriz', active: true });
  const doctor = await User.create({
    name: 'Rosi Echeverria', email: `dra${Date.now()}@test.com`, password: '123456',
    clinics: [{ clinic: sede._id, role: 'doctor' }],
  });
  const paciente = await Patient.create({ clinic: sede._id, firstName: 'Ana', lastName: 'P' });
  const servicio = async (name, salePrice) => {
    const product = await Product.collection.insertOne({ name, code: name, salePrice, clinic: sede._id });
    return AppointmentServiceItem.create({ clinic: sede._id, name, slug: name.toLowerCase(), product: product.insertedId });
  };
  const eco = await servicio('ECO 360', 15);
  const consulta = await servicio('CONSULTA POR SEGUIMIENTO', 12);
  const regla = (svc, extra) => CommissionRule.create({
    clinic: sede._id, name: `Tarifa ${svc.name}`, managedFromDoctorCommissions: true,
    doctorCommissionScope: 'service', doctorServiceDoctor: doctor._id, appointmentService: svc._id,
    targetType: 'user', users: [doctor._id], active: true, ...extra,
  });
  await regla(eco, { amountType: 'fixed', amount: 1.5 });
  await regla(consulta, { amountType: 'percent', percent: 30 });
  const cita = (extra) => Appointment.create({
    clinic: sede._id, patient: paciente._id, doctor: doctor._id,
    date: new Date('2026-10-19T15:00:00Z'), startTime: '10:00',
    status: 'completada', serviceItem: eco._id, serviceName: eco.name,
    additionalServices: [{ serviceItem: consulta._id, name: consulta.name }], ...extra,
  });
  return { sede, doctor, eco, consulta, cita };
}

const lineasDe = async (sede) => {
  const calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-10-01', end: '2026-11-30' });
  return Object.fromEntries(calc.lineas.map((l) => [l.serviceName, l]));
};

test('distribuye la venta prepagada por sesión y conserva el servicio adicional cobrado', async () => {
  const { sede, doctor, eco, consulta, cita } = await escenario();
  await User.updateOne({ _id: doctor._id }, { name: 'Domenica Prueba' });
  await CommissionRule.updateOne({ appointmentService: eco._id }, { amountType: 'percent', percent: 10 });
  const primera = await cita({ date: new Date('2026-11-01T15:00:00Z'), additionalServices: [] });
  const segunda = await cita({ date: new Date('2026-11-02T15:00:00Z') });
  const venta = await Sale.create({
    clinic: sede._id, saleNumber: 'PRE-1', appointment: primera._id,
    items: [{ product: eco.product, productName: eco.name, category: 'servicio', prepaid: true, quantity: 4, unitPrice: 25, lineTotal: 100, subtotal: 100 }],
    subtotal: 100, taxAmount: 0, total: 100, paymentMethod: 'efectivo', status: 'completada',
  });
  await PrepaidService.create({ clinic: sede._id, patient: primera.patient, product: eco.product, sale: venta._id, quantity: 4,
    uses: [{ appointment: primera._id }, { appointment: segunda._id }] });
  await Sale.create({ clinic: sede._id, saleNumber: 'EXTRA-1', appointment: segunda._id,
    items: [{ product: consulta.product, productName: consulta.name, category: 'servicio', quantity: 1, unitPrice: 10, lineTotal: 10, subtotal: 10 }],
    subtotal: 10, taxAmount: 0, total: 10, paymentMethod: 'efectivo', status: 'completada' });
  const calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-11-01', end: '2026-11-30' });
  const linea = (apt, service) => calc.lineas.find((l) => l.apptId === String(apt._id) && l.serviceName === service.name);
  assert.equal(linea(primera, eco).amount, 2.5);
  assert.equal(linea(segunda, eco).amount, 2.5);
  assert.equal(linea(segunda, consulta).amount, 3);
});

test('la tarifa por paciente acredita el valor de cada sesión prepagada', async () => {
  const { sede, doctor, eco, cita } = await escenario();
  await User.updateOne({ _id: doctor._id }, { name: 'Domenica Prueba' });
  await CommissionRule.deleteMany({ doctorServiceDoctor: doctor._id });
  await CommissionRule.create({ clinic: sede._id, name: 'Paciente', managedFromDoctorCommissions: true,
    doctorCommissionScope: 'patient', doctorServiceDoctor: doctor._id, targetType: 'user', users: [doctor._id], active: true, amountType: 'percent', percent: 10 });
  const a = await cita({ date: new Date('2026-11-01T15:00:00Z'), additionalServices: [] });
  const b = await cita({ date: new Date('2026-11-02T15:00:00Z'), additionalServices: [] });
  const v = await Sale.create({ clinic: sede._id, saleNumber: 'PRE-2', appointment: a._id,
    items: [{ product: eco.product, productName: eco.name, category: 'servicio', prepaid: true, quantity: 4, unitPrice: 25, lineTotal: 100, subtotal: 100 }],
    subtotal: 100, taxAmount: 0, total: 100, paymentMethod: 'efectivo', status: 'completada' });
  await PrepaidService.create({ clinic: sede._id, patient: a.patient, product: eco.product, sale: v._id, quantity: 4, uses: [{ appointment: a._id }, { appointment: b._id }] });
  const calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-11-01', end: '2026-11-30' });
  assert.deepStrictEqual(calc.lineas.map((l) => l.amount), [2.5, 2.5]);
});

test('una sesión histórica conciliada usa el valor unitario de su venta', async () => {
  const { sede, doctor, eco, cita } = await escenario();
  await User.updateOne({ _id: doctor._id }, { name: 'Domenica Prueba' });
  await CommissionRule.deleteMany({ doctorServiceDoctor: doctor._id });
  await CommissionRule.create({ clinic: sede._id, name: 'Paciente', managedFromDoctorCommissions: true,
    doctorCommissionScope: 'patient', doctorServiceDoctor: doctor._id, targetType: 'user', users: [doctor._id], active: true, amountType: 'percent', percent: 10 });
  const a = await cita({ date: new Date('2026-11-02T15:00:00Z'), additionalServices: [] });
  const v = await Sale.create({ clinic: sede._id, patient: a.patient, saleNumber: 'HIST-1',
    items: [{ product: eco.product, productName: eco.name, category: 'servicio', quantity: 4, unitPrice: 25, lineTotal: 100, subtotal: 100 }],
    subtotal: 100, taxAmount: 0, total: 100, paymentMethod: 'efectivo', status: 'completada' });
  await CommissionPrepaidAllocation.create({ appointment: a._id, sale: v._id, product: eco.product });
  let calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-11-01', end: '2026-11-30' });
  assert.equal(calc.lineas[0].amount, 2.5);
  await Sale.updateOne({ _id: v._id }, { status: 'anulada' });
  calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-11-01', end: '2026-11-30' });
  assert.equal(calc.lineas[0].amount, 0);
});

test('una corrección de base cambia la comisión sin cambiar el valor de la cita', async () => {
  const { sede, doctor, eco, cita } = await escenario();
  await User.updateOne({ _id: doctor._id }, { name: 'Domenica Prueba' });
  await CommissionRule.deleteMany({ doctorServiceDoctor: doctor._id });
  await CommissionRule.create({ clinic: sede._id, name: 'Paciente', managedFromDoctorCommissions: true,
    doctorCommissionScope: 'patient', doctorServiceDoctor: doctor._id, targetType: 'user', users: [doctor._id], active: true, amountType: 'percent', percent: 10 });
  const a = await cita({ serviceItem: eco._id, serviceName: eco.name, additionalServices: [], agreedValue: 58 });
  await CommissionBaseOverride.create({ appointment: a._id, doctor: doctor._id, base: 29, reason: 'Valor del servicio confirmado' });
  const calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-10-01', end: '2026-10-31' });
  assert.equal(calc.lineas[0].amount, 2.9);
  assert.equal((await Appointment.findById(a._id)).agreedValue, 58);
});

test('tarifa base complementaria paga servicios sin tarifa propia y respeta las tarifas específicas', async () => {
  const { sede, doctor, eco, consulta, cita } = await escenario();
  await User.updateOne({ _id: doctor._id }, { name: 'Domenica Prueba' });
  await CommissionRule.deleteOne({ appointmentService: eco._id });
  await CommissionRule.updateOne({ appointmentService: consulta._id }, { percent: 5 });
  await CommissionRule.create({ clinic: sede._id, name: 'Paciente', managedFromDoctorCommissions: true,
    doctorCommissionScope: 'patient', doctorServiceDoctor: doctor._id, targetType: 'user', users: [doctor._id], active: true,
    amountType: 'percent', percent: 10, patientRateForUnconfiguredServices: true });
  const a = await cita({ date: new Date('2026-11-03T15:00:00Z') });
  await Sale.create({ clinic: sede._id, saleNumber: 'MIX-1', appointment: a._id,
    items: [
      { product: eco.product, productName: eco.name, category: 'servicio', quantity: 1, unitPrice: 29, lineTotal: 29, subtotal: 29 },
      { product: consulta.product, productName: consulta.name, category: 'servicio', quantity: 1, unitPrice: 69, lineTotal: 69, subtotal: 69 },
    ], subtotal: 98, taxAmount: 0, total: 98, paymentMethod: 'efectivo', status: 'completada' });
  const calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-11-01', end: '2026-11-30' });
  assert.equal(calc.lineas.find((l) => l.kind === 'servicio').amount, 3.45);
  assert.equal(calc.lineas.find((l) => l.kind === 'paciente').amount, 2.9);
  await CommissionRule.create({ clinic: sede._id, name: 'Exento', managedFromDoctorCommissions: true,
    doctorCommissionScope: 'service', doctorServiceDoctor: doctor._id, appointmentService: eco._id,
    targetType: 'user', users: [doctor._id], active: true, amountType: 'fixed', amount: 0 });
  const exenta = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-11-01', end: '2026-11-30' });
  assert.equal(exenta.lineas.reduce((sum, l) => sum + l.amount, 0), 3.45);
});

test('antes de la facturación: cada servicio usa su precio de inventario', async () => {
  const { sede, cita } = await escenario();
  await cita({ agreedValue: 23 });
  const l = await lineasDe(sede);
  assert.strictEqual(l['ECO 360'].amount, 1.5);
  assert.strictEqual(l['CONSULTA POR SEGUIMIENTO'].base, 12);
  assert.strictEqual(l['CONSULTA POR SEGUIMIENTO'].amount, 3.6);
});

test('con factura: el porcentaje va sobre la línea facturada del servicio', async () => {
  const { sede, eco, consulta, cita } = await escenario();
  const apt = await cita({ date: new Date('2026-11-03T15:00:00Z') });
  const [ecoItem, consultaItem] = await Promise.all([
    AppointmentServiceItem.findById(eco._id).lean(),
    AppointmentServiceItem.findById(consulta._id).lean(),
  ]);
  await Sale.create({
    clinic: sede._id, saleNumber: 'V-1', appointment: apt._id,
    items: [
      { product: ecoItem.product, productName: 'ECO', category: 'servicio', quantity: 1, unitPrice: 15, lineTotal: 15, subtotal: 15 },
      { product: consultaItem.product, productName: 'CONSULTA', category: 'servicio', quantity: 1, unitPrice: 10, lineTotal: 10, subtotal: 10 },
    ],
    subtotal: 25, taxAmount: 0, total: 25, paymentMethod: 'efectivo', status: 'completada',
  });
  const l = await lineasDe(sede);
  assert.strictEqual(l['CONSULTA POR SEGUIMIENTO'].base, 10);
  assert.strictEqual(l['CONSULTA POR SEGUIMIENTO'].amount, 3);
});

test('un solo servicio histórico: el porcentaje usa el precio de inventario', async () => {
  const { sede, consulta, cita } = await escenario();
  await cita({ serviceItem: consulta._id, serviceName: consulta.name, additionalServices: [], agreedValue: 15 });
  const l = await lineasDe(sede);
  assert.strictEqual(l['CONSULTA POR SEGUIMIENTO'].amount, 3.6);
});

test('plan vital y bio scaner usan sus precios propios, incluido el descuento del scaner', async () => {
  const { sede, doctor, cita } = await escenario();
  const crear = async (name, price) => {
    const p = await Product.collection.insertOne({ name, code: name, salePrice: price, clinic: sede._id, taxCategory: 'IVA_0' });
    return AppointmentServiceItem.create({ clinic: sede._id, name, slug: name.toLowerCase(), product: p.insertedId });
  };
  const femenino = await crear('PLAN VITAL FEMENINO', 29);
  const masculino = await crear('PLAN VITAL MASCULINO', 29);
  const bio = await crear('BIO SCANER COMPUTARIZADO', 30);
  for (const s of [femenino, masculino, bio]) await CommissionRule.create({
    clinic: sede._id, name: s.name, managedFromDoctorCommissions: true, doctorCommissionScope: 'service',
    doctorServiceDoctor: doctor._id, appointmentService: s._id, targetType: 'user', users: [doctor._id],
    active: true, amountType: 'percent', percent: 20,
  });
  const caso = async (plan, adicionales, extra = {}) => {
    await Appointment.deleteMany({});
    await cita({ serviceItem: plan._id, serviceName: plan.name,
      additionalServices: adicionales.map((s) => ({ serviceItem: s._id, name: s.name })),
      agreedValue: 100, ...extra });
    return lineasDe(sede);
  };
  for (const plan of [femenino, masculino]) {
    const l = await caso(plan, [bio]);
    assert.strictEqual(l[plan.name].amount, 5.8);
    assert.strictEqual(l[bio.name].base, 15);
    assert.strictEqual(l[bio.name].amount, 3);
  }
  const solo = await caso(bio, []);
  assert.strictEqual(solo[bio.name].base, 30);
  assert.strictEqual(solo[bio.name].amount, 6);
  const canje = await caso(femenino, [bio], { isCanje: true });
  assert.deepStrictEqual(canje, {});
});

test('Rosi excluye canjes y cortesías y respeta las condiciones de los demás doctores', async () => {
  const { sede, doctor, consulta, cita } = await escenario();
  const otro = await User.create({ name: 'Otra Doctora', email: 'otra@test.com', password: '123456', clinics: [{ clinic: sede._id, role: 'doctor' }] });
  await AppointmentServiceItem.updateOne({ _id: consulta._id }, { $addToSet: { excludedCommissionDoctors: { $each: [doctor._id, otro._id] } } });
  await CommissionRule.updateOne({ doctorServiceDoctor: doctor._id, appointmentService: consulta._id }, { $set: { firstTimeOnly: true, minStartTime: '12:00' } });
  await CommissionRule.create({ clinic: sede._id, name: 'Otra consulta', managedFromDoctorCommissions: true,
    doctorCommissionScope: 'service', doctorServiceDoctor: otro._id, appointmentService: consulta._id,
    targetType: 'user', users: [otro._id], active: true, amountType: 'percent', percent: 30 });
  const datos = { serviceItem: consulta._id, serviceName: consulta.name, additionalServices: [], agreedValue: 25 };
  await cita(datos);
  await cita({ ...datos, isCortesia: true, agreedValue: 0 });
  await cita({ ...datos, isCanje: true, agreedValue: 0 });
  await cita({ ...datos, doctor: otro._id });
  const calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-10-01', end: '2026-10-31' });
  const propias = calc.lineas.filter((l) => l.doctorId === String(doctor._id));
  assert.deepStrictEqual(propias.map((l) => l.amount), [3.6]);
  assert.strictEqual(calc.lineas.filter((l) => l.doctorId === String(otro._id)).length, 0);
  let payload;
  await ctrl.report({ clinicId: sede._id, query: { start: '2026-10-01', end: '2026-10-31', user: String(doctor._id) } }, {
    json: (p) => { payload = p; }, status: (s) => ({ json: (p) => { throw new Error(`${s}: ${JSON.stringify(p)}`); } }),
  });
  assert.strictEqual(payload.total, 3.6, 'contabilización y PDF usan el mismo importe');
});

test('cortesía o canje de un solo servicio en una cita con varios servicios', async () => {
  const { sede, consulta, eco, cita } = await escenario();
  await cita({ agreedValue: 15, noChargeServices: [{ serviceItem: consulta._id, kind: 'cortesia' }] });
  let l = await lineasDe(sede);
  assert.strictEqual(l[consulta.name], undefined);
  assert.strictEqual(l[eco.name].amount, 1.5);
  await Appointment.deleteMany({});
  await cita({ agreedValue: 15, noChargeServices: [{ serviceItem: consulta._id, kind: 'canje' }] });
  l = await lineasDe(sede);
  assert.strictEqual(l[consulta.name], undefined);
  assert.strictEqual(l[eco.name].amount, 1.5);
});

test('Vital Femenino antiguo y plan sin valor usan el precio del producto de su empresa', async () => {
  const { sede, doctor, cita } = await escenario();
  const company = new mongoose.Types.ObjectId();
  const nombre = 'PLAN VITAL FEMENINO (ECOGRAFIA DE MAMAS - CONTROL HORMONAL - BIORESONANCIA )';
  const p = await Product.collection.insertOne({ name: nombre, code: 'PLAN', salePrice: 29, clinic: sede._id, taxCategory: 'IVA_0' });
  const plan = await AppointmentServiceItem.create({ clinic: sede._id, company, name: nombre, slug: nombre.toLowerCase(), product: p.insertedId });
  const antiguo = await AppointmentServiceItem.create({ clinic: sede._id, company, name: 'Vital Femenino', slug: 'vital femenino' });
  for (const s of [antiguo, plan]) await CommissionRule.create({
    clinic: sede._id, name: `Tarifa ${s.name}`, managedFromDoctorCommissions: true,
    doctorCommissionScope: 'service', doctorServiceDoctor: doctor._id, appointmentService: s._id,
    targetType: 'user', users: [doctor._id], active: true, amountType: 'percent', percent: 20,
  });
  const a = await cita({ date: new Date('2026-10-03T17:00:00Z'), serviceItem: antiguo._id, serviceName: antiguo.name, additionalServices: [], agreedValue: null });
  const b = await cita({ date: new Date('2026-10-31T17:00:00Z'), serviceItem: plan._id, serviceName: plan.name, additionalServices: [], agreedValue: null });
  const calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-10-01', end: '2026-10-31' });
  for (const apt of [a, b]) {
    const linea = calc.lineas.find((l) => l.apptId === String(apt._id));
    assert.strictEqual(linea.base, 29);
    assert.strictEqual(linea.amount, 5.8);
  }
  let payload;
  await ctrl.report({ clinicId: sede._id, query: { start: '2026-10-01', end: '2026-10-31', user: String(doctor._id) } }, {
    json: (p) => { payload = p; }, status: (s) => ({ json: (p) => { throw new Error(`${s}: ${JSON.stringify(p)}`); } }),
  });
  assert.strictEqual(payload.total, 11.6);
});
