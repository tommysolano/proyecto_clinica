process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

/**
 * LA TARIFA DEL DOCTOR NO SE QUEDA EN UNA SUCURSAL (oct-2026).
 *
 * Caso real (Dr. Orces): la tarifa de «Consulta y terapia neurofocal» se definió
 * mirando un período en que solo atendía en Extensión, y se guardó solo ahí.
 * Las 9 citas del mismo servicio en Laboratorio sumaban $0 en silencio, la
 * pantalla decía «(parcial)» y el PDF listaba 11 de 20 citas.
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Appointment = require('../models/Appointment');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
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

const reqDe = (clinicId, extra = {}) => ({
  clinicId,
  user: { _id: new mongoose.Types.ObjectId(), isSuperAdmin: true },
  query: {}, body: {}, params: {},
  ...extra,
});
const llamar = async (fn, req) => {
  let payload = null;
  let code = 200;
  const res = {
    json: (p) => { payload = p; },
    status: (s) => { code = s; return { json: (p) => { payload = p; } }; },
  };
  await fn(req, res);
  return { payload, code };
};
const dia = (d) => new Date(2026, 9, d, 12, 0, 0, 0);

async function escenario() {
  const extension = await Clinic.create({ name: 'Extensión', nombreComercial: 'Extensión', active: true });
  const laboratorio = await Clinic.create({ name: 'Laboratorio', nombreComercial: 'Laboratorio', active: true });
  const doctor = await User.create({
    name: 'Doctor Dos Sedes', email: `dos${Date.now()}@test.com`, password: '123456',
    clinics: [{ clinic: extension._id, role: 'doctor' }, { clinic: laboratorio._id, role: 'doctor' }],
  });
  const paciente = await Patient.create({ clinic: extension._id, firstName: 'Ana', lastName: 'P' });
  const consulta = await AppointmentServiceItem.create({ clinic: extension._id, name: 'CONSULTA NEURO', slug: `consulta-neuro-${Date.now()}` });
  const cita = (clinic, d) => ({
    clinic: clinic._id, patient: paciente._id, doctor: doctor._id, date: dia(d), startTime: '09:00',
    status: 'completada', serviceItem: consulta._id, serviceName: 'CONSULTA NEURO', agreedValue: 30,
  });
  await Appointment.create([cita(extension, 12), cita(laboratorio, 13), cita(laboratorio, 14)]);
  // La tarifa se define SOLO en Extensión, como pasó en producción.
  const g = await llamar(ctrl.saveDoctorServiceRule, reqDe(extension._id, {
    body: { doctor: String(doctor._id), service: String(consulta._id), clinics: [String(extension._id)], amountType: 'fixed', value: 10 },
  }));
  assert.strictEqual(g.code, 200);
  return { extension, laboratorio, doctor, consulta };
}

test('la sede sin tarifa propia usa la del doctor en otra sede', async () => {
  const { extension, doctor, consulta } = await escenario();
  const r = await llamar(ctrl.doctorSummary, reqDe(extension._id, { query: { start: '2026-10-01', end: '2026-10-31', clinic: 'all' } }));
  const fila = r.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  const svc = fila.services.find((s) => s.serviceId === String(consulta._id));
  assert.strictEqual(svc.count, 3);
  assert.strictEqual(svc.commission.earned, 30, 'las tres citas pagan $10');
  assert.strictEqual(svc.commission.partial, false, 'ya no es «parcial»');
  assert.strictEqual(fila.commissionTotal, 30);
});

test('la tarifa propia de una sede sigue mandando sobre la de otra', async () => {
  const { extension, laboratorio, doctor, consulta } = await escenario();
  await CommissionRule.create({
    clinic: laboratorio._id, name: 'propia', active: true, targetType: 'user', user: doctor._id, users: [doctor._id],
    trigger: 'appointment_performed', triggers: ['appointment_performed'], appointmentService: consulta._id,
    doctorServiceDoctor: doctor._id, managedFromDoctorCommissions: true, doctorCommissionScope: 'service',
    amountType: 'fixed', amount: 5,
  });
  const r = await llamar(ctrl.doctorSummary, reqDe(extension._id, { query: { start: '2026-10-01', end: '2026-10-31', clinic: 'all' } }));
  const fila = r.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila.commissionTotal, 20, '10 en Extensión + 5 + 5 en Laboratorio');
});

test('eliminar la tarifa la quita de todas las sedes del doctor', async () => {
  const { extension, laboratorio, doctor, consulta } = await escenario();
  // Se elimina mirando un período con citas solo en Laboratorio.
  const del = await llamar(ctrl.saveDoctorServiceRule, reqDe(laboratorio._id, {
    body: { doctor: String(doctor._id), service: String(consulta._id), clinics: [String(laboratorio._id)], active: false },
  }));
  assert.strictEqual(del.code, 200);
  const quedan = await CommissionRule.countDocuments({ doctorServiceDoctor: doctor._id, appointmentService: consulta._id });
  assert.strictEqual(quedan, 0);
  const r = await llamar(ctrl.doctorSummary, reqDe(extension._id, { query: { start: '2026-10-01', end: '2026-10-31', clinic: 'all' } }));
  const fila = r.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila.commissionTotal, 0);
});
