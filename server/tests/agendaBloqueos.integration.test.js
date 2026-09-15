/**
 * BLOQUEOS DE HORARIO de la agenda (`TimeBlock`) y su aplicación al agendar.
 *
 * Lo que fijan estos tests (sep-2026, a petición del usuario):
 *   1. un bloqueo GENERAL (sin servicio/doctor) rechaza la cita en la franja
 *      bloqueada y el mensaje lleva el motivo;
 *   2. un bloqueo por SERVICIO solo bloquea las citas de ESE servicio: las
 *      demás y las fuera de la franja pasan;
 *   3. un bloqueo por DOCTOR solo bloquea las citas de ese doctor;
 *   4. MARKETING puede crearlos (espejo del menú «Bloqueos de horarios»).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const appt = require('../controllers/appointmentController');
const tb = require('../controllers/timeBlockController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Central' });
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  const s1 = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Limpieza', slug: 'limpieza', color: '#0ea5e9',
  });
  const s2 = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Ortodoncia', slug: 'ortodoncia', color: '#f59e0b',
  });
  const doc = await User.create({
    name: 'DocA', email: 'doca@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  return { clinicId, userId, patient, s1, s2, doc };
}

/** Mañana, para no chocar con la validación de hora pasada. */
const manana = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

const agendar = (clinicId, userId, body, role = 'admin') =>
  H.runController(appt.createAppointment, H.mockReq(clinicId, userId, body, { role }));

const crearBloqueo = (clinicId, userId, body, role = 'admin') =>
  H.runController(tb.create, H.mockReq(clinicId, userId, body, { role }));

test('un bloqueo GENERAL rechaza la cita en la franja y dice el motivo', async () => {
  const { clinicId, userId, patient } = await seed();
  ok(await crearBloqueo(clinicId, userId, {
    startDate: manana(), endDate: manana(),
    allDay: false, startTime: '09:00', endTime: '10:00',
    reason: 'Capacitación del personal',
  }));

  const r = await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '09:30', serviceItem: null,
  });
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /Horario bloqueado/);
  assert.match(r.payload.message, /Capacitación/);
});

test('un bloqueo por SERVICIO solo bloquea ese servicio (y fuera de la franja no aplica)', async () => {
  const { clinicId, userId, patient, s1, s2 } = await seed();
  ok(await crearBloqueo(clinicId, userId, {
    startDate: manana(), endDate: manana(),
    allDay: false, startTime: '09:00', endTime: '10:00',
    service: s1._id, reason: 'Mantenimiento de equipos',
  }));

  // El servicio bloqueado, dentro de la franja: rechazado.
  const r1 = await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '09:30', serviceItem: s1._id,
  });
  assert.equal(r1.statusCode, 400, JSON.stringify(r1.payload));
  assert.match(r1.payload.message, /Mantenimiento/);

  // OTRO servicio en la misma franja: pasa.
  ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '09:30', serviceItem: s2._id,
  }));

  // El servicio bloqueado, FUERA de la franja: pasa.
  ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '11:00', serviceItem: s1._id,
  }));
});

test('un bloqueo por DOCTOR solo bloquea las citas de ese doctor', async () => {
  const { clinicId, userId, patient, s1, doc } = await seed();
  ok(await crearBloqueo(clinicId, userId, {
    startDate: manana(), endDate: manana(),
    allDay: false, startTime: '09:00', endTime: '12:00',
    doctor: String(doc._id), reason: 'Congreso',
  }));

  const r = await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '10:00', serviceItem: s1._id,
    doctor: String(doc._id),
  });
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));

  // Sin doctor asignado la cita pasa: el bloqueo era solo del doctor.
  ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '10:00', serviceItem: s1._id,
  }));
});

test('MARKETING puede crear bloqueos (y rechazan agendar igual)', async () => {
  const { clinicId, userId, patient, s1 } = await seed();
  const r = await crearBloqueo(clinicId, userId, {
    startDate: manana(), endDate: manana(), allDay: true,
    reason: 'Feriado de la sucursal',
  }, 'marketing');
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const cita = await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '10:00', serviceItem: s1._id,
  }, 'call_center');
  assert.equal(cita.statusCode, 400, JSON.stringify(cita.payload));
});

test('fuera del rango de fechas del bloqueo no se bloquea nada', async () => {
  const { clinicId, userId, patient, s1 } = await seed();
  const pasado = new Date();
  pasado.setDate(pasado.getDate() - 2);
  ok(await crearBloqueo(clinicId, userId, {
    startDate: pasado.toISOString().slice(0, 10),
    endDate: pasado.toISOString().slice(0, 10),
    allDay: true, reason: 'Día pasado',
  }));

  ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '10:00', serviceItem: s1._id,
  }));
  assert.equal(await Appointment.countDocuments({}), 1);
});
