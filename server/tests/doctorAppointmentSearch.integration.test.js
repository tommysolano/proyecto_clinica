const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const { searchDoctorAppointments } = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('el doctor encuentra citas de otros días y solo las de sus turnos', async () => {
  const { clinicId } = await H.seedClinic();
  const doctor = await User.create({
    name: 'Doctora Uno', email: 'doctora1@test.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const otro = await User.create({
    name: 'Doctor Dos', email: 'doctor2@test.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const ana = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez' });
  const otraPaciente = await Patient.create({ clinic: clinicId, firstName: 'María', lastName: 'Ramos' });
  const pasado = new Date(H.docDate());
  pasado.setMonth(pasado.getMonth() - 4);
  const futuro = new Date(H.docDate());
  futuro.setMonth(futuro.getMonth() + 2);
  const citaPasada = await Appointment.create({
    clinic: clinicId, patient: ana._id, date: pasado, startTime: '09:00',
    status: 'completada', doctor: doctor._id,
    turns: [{ kind: 'doctor', user: doctor._id, status: 'completado' }],
  });
  const citaFutura = await Appointment.create({
    clinic: clinicId, patient: ana._id, date: futuro, startTime: '10:00',
    status: 'pendiente', doctor: doctor._id, currentTurnUser: doctor._id,
    attentionAssignedAt: new Date(),
    turns: [{ kind: 'doctor', user: doctor._id, status: 'pendiente' }],
  });
  await Appointment.create({
    clinic: clinicId, patient: ana._id, date: pasado, startTime: '11:00',
    status: 'completada', doctor: otro._id,
    turns: [{ kind: 'doctor', user: otro._id, status: 'completado' }],
  });
  await Appointment.create({
    clinic: clinicId, patient: otraPaciente._id, date: pasado, startTime: '12:00',
    status: 'completada', doctor: doctor._id,
    turns: [{ kind: 'doctor', user: doctor._id, status: 'completado' }],
  });

  const req = H.mockReq(clinicId, doctor._id, {}, { role: 'doctor', query: { q: 'Ana' } });
  req.user.clinics = doctor.clinics;
  const r = await H.runController(searchDoctorAppointments, req);
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  assert.deepEqual(r.payload.appointments.map((a) => String(a._id)), [String(citaFutura._id), String(citaPasada._id)]);
  assert.equal(r.payload.hasMore, false);
  assert.equal(r.payload.appointments[1].patient.firstName, 'ANA');
});
