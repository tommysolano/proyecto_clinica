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
    name: 'Dra. Prueba', email: `dra${Date.now()}@test.com`, password: '123456',
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
  const calc = await ctrl._calcularComisionesDoctores(sede._id, { start: '2026-10-01', end: '2026-10-31' });
  return Object.fromEntries(calc.lineas.map((l) => [l.serviceName, l]));
};

test('sin factura: el valor escrito se reparte por el precio de lista de cada servicio', async () => {
  const { sede, cita } = await escenario();
  await cita({ agreedValue: 23 });
  const l = await lineasDe(sede);
  assert.strictEqual(l['ECO 360'].amount, 1.5);
  // 23 × 12 / (15 + 12) = 10,22 → 30 % = 3,07 (antes 30 % × 23 = 6,90)
  assert.strictEqual(l['CONSULTA POR SEGUIMIENTO'].base, 10.22);
  assert.strictEqual(l['CONSULTA POR SEGUIMIENTO'].amount, 3.07);
});

test('con factura: el porcentaje va sobre la línea facturada del servicio', async () => {
  const { sede, eco, consulta, cita } = await escenario();
  const apt = await cita({});
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

test('un solo servicio: el porcentaje sigue yendo sobre toda la visita', async () => {
  const { sede, consulta, cita } = await escenario();
  await cita({ serviceItem: consulta._id, serviceName: consulta.name, additionalServices: [], agreedValue: 15 });
  const l = await lineasDe(sede);
  assert.strictEqual(l['CONSULTA POR SEGUIMIENTO'].amount, 4.5);
});
