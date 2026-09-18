process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Appointment = require('../models/Appointment');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const ctrl = require('../controllers/commissionController');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const construir = async () => {
  const clinicA = await Clinic.create({ name: 'Central', nombreComercial: 'Central', active: true });
  const clinicB = await Clinic.create({ name: 'Extension', nombreComercial: 'Extensión', active: true });
  const doctor = await User.create({
    name: 'Jorge Perez', email: 'jorge@test.com', password: '123456',
    clinics: [{ clinic: clinicA._id, role: 'doctor' }], specialty: 'General',
  });
  const otro = await User.create({
    name: 'Ana Lopez', email: 'ana@test.com', password: '123456',
    clinics: [{ clinic: clinicA._id, role: 'optica' }],
  });
  const paciente = await Patient.create({ clinic: clinicA._id, firstName: 'Luis', lastName: 'Rojas' });
  const consulta = await AppointmentServiceItem.create({ clinic: clinicA._id, name: 'Consulta', slug: 'consulta' });
  const detox = await AppointmentServiceItem.create({ clinic: clinicA._id, name: 'Detox', slug: 'detox' });

  const dia = (d) => new Date(2026, 7, d, 12, 0, 0, 0);
  await Appointment.create([
    { clinic: clinicA._id, patient: paciente._id, doctor: doctor._id, date: dia(5), startTime: '09:00', status: 'asistida', serviceName: 'Consulta' },
    { clinic: clinicA._id, patient: paciente._id, doctor: doctor._id, date: dia(6), startTime: '09:00', status: 'completada', serviceName: 'Detox' },
    { clinic: clinicB._id, patient: paciente._id, doctor: doctor._id, date: dia(7), startTime: '09:00', status: 'asistida', serviceName: 'Detox' },
    { clinic: clinicA._id, patient: paciente._id, doctor: otro._id, date: dia(8), startTime: '09:00', status: 'cancelada', serviceName: 'Consulta' },
  ]);
  return { clinicA, clinicB, doctor, otro, consulta, detox };
};

const reqDe = (clinicId) => ({
  clinicId,
  user: { isSuperAdmin: true },
  query: {},
});

const respDe = () => {
  let payload = null;
  let status = 200;
  return {
    json: (p) => { payload = p; },
    status: (s) => { status = s; return { json: (p) => { payload = p; } }; },
    get payload() { return payload; },
    get status() { return status; },
  };
};

test('resume las citas por doctor con estados y servicios', async () => {
  const { clinicA, doctor, otro, consulta, detox } = await construir();
  const req = reqDe(clinicA._id);
  req.query = { start: '2026-08-01', end: '2026-08-31' };
  const res = respDe();
  await ctrl.doctorSummary(req, res);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.payload.totals.total, 2);
  const fila = res.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.ok(fila);
  assert.strictEqual(fila.total, 2);
  assert.strictEqual(fila.byStatus.asistida, 1);
  assert.strictEqual(fila.byStatus.completada, 1);
  const nombres = fila.services.map((s) => s.name).sort();
  assert.deepStrictEqual(nombres, ['Consulta', 'Detox']);
  assert.strictEqual(fila.clinics[0], 'Central');
  // el doctor de la otra especialidad no aparece porque su única cita es 'cancelada'
  // (fuera del filtro por defecto asistida+completada)
  assert.ok(!res.payload.doctors.some((d) => d.doctorId === String(otro._id)));

  // filtro por UN servicio: solo la cita de Detox
  const req2 = reqDe(clinicA._id);
  req2.query = { start: '2026-08-01', end: '2026-08-31', service: String(detox._id), status: 'asistida,completada' };
  const res2 = respDe();
  await ctrl.doctorSummary(req2, res2);
  assert.strictEqual(res2.payload.totals.total, 1);
  const fila2 = res2.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila2.byStatus.completada, 1);
  assert.strictEqual(fila2.byStatus.asistida, 0);
  assert.deepStrictEqual(fila2.services.map((s) => s.name), ['Detox']);

  // cita de la OTRA sucursal (no entra por defecto: sin 'clinic=all' es solo la activa)
  const req4 = reqDe(clinicA._id);
  req4.query = { start: '2026-08-01', end: '2026-08-31', clinic: 'all' };
  const res4 = respDe();
  await ctrl.doctorSummary(req4, res4);
  assert.strictEqual(res4.payload.totals.total, 3);
  const fila4 = res4.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila4.total, 3);
  assert.ok(fila4.clinics.includes('Central'));
  assert.ok(fila4.clinics.includes('Extensión'));

  // cita sin estado: la del servicio Consulta
  const req3 = reqDe(clinicA._id);
  req3.query = { start: '2026-08-01', end: '2026-08-31', service: String(consulta._id), status: 'asistida,completada,cancelada' };
  const res3 = respDe();
  await ctrl.doctorSummary(req3, res3);
  assert.strictEqual(res3.payload.totals.total, 2);
  const fila3 = res3.payload.doctors.find((d) => d.doctorId === String(otro._id));
  assert.strictEqual(fila3.byStatus.cancelada, 1);
});
