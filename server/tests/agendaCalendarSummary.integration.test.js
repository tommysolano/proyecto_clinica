/**
 * EL RESUMEN DEL CALENDARIO (`GET /api/appointments/calendar-summary`).
 *
 * La vista de calendario del mes tardaba una eternidad en cargar: pedía TODAS
 * las citas del mes con paciente, doctor, turnos y servicios poblados para
 * contar en el navegador — y solo pinta el total por día y los contadores por
 * estado. Ahora pide ESTE resumen, que baja solo `date` y `status`.
 *
 * Lo que fijan estos tests:
 *   1. los contadores por día usan el MISMO criterio que contaba el navegador:
 *      asistida = asistida o completada; cancelada solo suma al total;
 *   2. los filtros del calendario (servicios VARIOS y doctor) viajan al
 *     servidor, con los mismos ids que manda la agenda;
 *   3. y `GET /appointments` acepta varios servicios separados por coma.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const appt = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ymd = (d) => {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
};

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  const doc = await User.create({
    name: 'DocA', email: 'doca@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const s1 = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Limpieza', slug: 'limpieza', color: '#0ea5e9',
  });
  const s2 = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Ortodoncia', slug: 'ortodoncia', color: '#f59e0b',
  });
  const hoy = H.docDate();
  const manana = new Date(hoy);
  manana.setDate(manana.getDate() + 1);
  const crear = (date, extra = {}) => Appointment.create({
    clinic: clinicId,
    patient: patient._id,
    date,
    startTime: '10:00',
    status: 'pendiente',
    ...extra,
  });
  // HOY: 5 citas — 1 pendiente, 2 asistidas (asistida + completada),
  // 1 no asistió y 1 cancelada (que solo cuenta en el total).
  await crear(hoy, { serviceItem: s1._id });
  await crear(hoy, { serviceItem: s1._id, status: 'asistida', doctor: doc._id });
  await crear(hoy, { serviceItem: s2._id, status: 'completada' });
  await crear(hoy, { serviceItem: s2._id, status: 'no_asistio' });
  await crear(hoy, { serviceItem: s1._id, status: 'cancelada' });
  // MAÑANA: otra día para el mismo resumen.
  await crear(manana, { serviceItem: s2._id });
  return { clinicId, userId, patient, doc, s1, s2, hoy, manana };
}

test('el resumen cuenta por día con el mismo criterio que pintaba el calendario', async () => {
  const { clinicId, userId, hoy, manana } = await seed();
  const r = await H.runController(appt.getCalendarSummary, H.mockReq(clinicId, userId, {}, {
    role: 'admin',
    query: { startDate: ymd(hoy), endDate: ymd(manana), clinic: 'all' },
  }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const dias = Object.fromEntries(r.payload.map((d) => [d.date, d]));
  assert.deepEqual(dias[ymd(hoy)], {
    date: ymd(hoy), total: 5, pendiente: 1, asistida: 2, no_asistio: 1,
  });
  assert.deepEqual(dias[ymd(manana)], {
    date: ymd(manana), total: 1, pendiente: 1, asistida: 0, no_asistio: 0,
  });
});

test('el resumen respeta los filtros de VARIOS servicios y de doctor', async () => {
  const { clinicId, userId, hoy, s1, doc } = await seed();
  // Ambos servicios: las 5 de hoy.
  const ambos = await H.runController(appt.getCalendarSummary, H.mockReq(clinicId, userId, {}, {
    role: 'admin',
    query: { startDate: ymd(hoy), endDate: ymd(hoy), clinic: 'all', service: `${s1._id}` },
  }));
  assert.equal(ambos.payload[0].total, 3, 'un solo servicio: pendiente + asistida + cancelada');

  const conDoctor = await H.runController(appt.getCalendarSummary, H.mockReq(clinicId, userId, {}, {
    role: 'admin',
    query: { startDate: ymd(hoy), endDate: ymd(hoy), clinic: 'all', doctor: String(doc._id) },
  }));
  assert.equal(conDoctor.payload.length, 1);
  assert.equal(conDoctor.payload[0].total, 1, 'solo la cita del doctor');
  assert.equal(conDoctor.payload[0].asistida, 1);
});

test('GET /appointments acepta VARIOS servicios separados por coma', async () => {
  const { clinicId, userId, hoy, s1, s2 } = await seed();
  const r = await H.runController(appt.getAppointments, H.mockReq(clinicId, userId, {}, {
    role: 'admin',
    query: { startDate: ymd(hoy), endDate: ymd(hoy), clinic: 'all', service: `${s1._id},${s2._id}` },
  }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  // Las 5 de hoy tienen servicio del catálogo (la cancelada incluida): sin el
  // filtro multi-servicio, la segunda alternativa pisaba a la primera.
  assert.equal(r.payload.length, 5, JSON.stringify(r.payload.map((a) => a.status)));
});
