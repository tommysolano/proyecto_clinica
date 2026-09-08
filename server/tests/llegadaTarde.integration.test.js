/**
 * QUIÉN LLEGÓ TARDE (sep-2026, a petición de los médicos).
 *
 * La cita era a las 9 y el paciente entra a las 9:40. Mostrador lo marca
 * «asistida» y a partir de ahí las dos citas —la del puntual y la del que llegó
 * con cuarenta minutos de retraso— se ven exactamente igual en la agenda, cuando
 * esa diferencia es justo la que explica por qué la mañana se corrió.
 *
 * Lo que fijan estos tests:
 *   1. el retraso se calcula contra la hora AGENDADA y se congela en la cita;
 *   2. se sella por las cuatro puertas que dejan una cita en 'asistida';
 *   3. y se sella UNA sola vez: re-marcar asistencia para añadir un doctor no
 *      puede correr la hora de llegada a media mañana.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const Appointment = require('../models/Appointment');
const appointments = require('../controllers/appointmentController');
const { registrarLlegada, llegoTarde } = require('../utils/appointmentArrival');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

// ─────────────────── el cálculo, a solas y sin reloj de por medio ───────────────────

test('el retraso se mide contra la hora agendada, en hora de Ecuador', () => {
  // La cita del 8-sep a las 09:00 (Ecuador es UTC-5, así que las 14:00 UTC).
  const cita = { date: new Date('2026-09-08T12:00:00Z'), startTime: '09:00' };
  registrarLlegada(cita, { at: new Date('2026-09-08T14:40:00Z') });

  assert.equal(cita.arrivalDelayMinutes, 40, 'entró cuarenta minutos tarde');
  assert.equal(llegoTarde(cita), true);
});

test('llegar unos minutos antes o justo a la hora no es llegar tarde', () => {
  const puntual = { date: new Date('2026-09-08T12:00:00Z'), startTime: '09:00' };
  registrarLlegada(puntual, { at: new Date('2026-09-08T14:05:00Z') });
  assert.equal(puntual.arrivalDelayMinutes, 5);
  assert.equal(llegoTarde(puntual), false, 'cinco minutos entran en la cortesía');

  const temprano = { date: new Date('2026-09-08T12:00:00Z'), startTime: '09:00' };
  registrarLlegada(temprano, { at: new Date('2026-09-08T13:45:00Z') });
  assert.equal(temprano.arrivalDelayMinutes, -15, 'llegó antes: el retraso es negativo');
  assert.equal(llegoTarde(temprano), false);
});

test('sin hora válida no se inventa un retraso: se deja en «no se sabe»', () => {
  const cita = { date: new Date('2026-09-08T12:00:00Z'), startTime: '' };
  registrarLlegada(cita, { at: new Date('2026-09-08T14:40:00Z') });

  assert.ok(cita.arrivedAt, 'la hora de llegada sí se guarda');
  assert.equal(cita.arrivalDelayMinutes, null);
  assert.equal(llegoTarde(cita), false, 'sin dato no se acusa a nadie de llegar tarde');
});

test('sellar dos veces no mueve la hora de llegada', () => {
  const cita = { date: new Date('2026-09-08T12:00:00Z'), startTime: '09:00' };
  assert.equal(registrarLlegada(cita, { at: new Date('2026-09-08T14:40:00Z') }), true);
  assert.equal(registrarLlegada(cita, { at: new Date('2026-09-08T16:00:00Z') }), false);

  assert.equal(cita.arrivalDelayMinutes, 40, 'sigue siendo la primera vez que entró');
});

// ─────────────────── y por las puertas por las que se marca asistencia ───────────────────

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Matriz' });
  const patient = await Patient.create({ clinic: clinicId, firstName: 'ANDREA', lastName: 'MACIAS' });
  return { clinicId, userId, patient };
}

/** Una cita de HOY a las 08:00: cuando se marque asistencia ya habrá pasado. */
async function citaDeHoy(clinicId, patient) {
  const hoy = new Date();
  hoy.setHours(12, 0, 0, 0);
  return Appointment.create({
    clinic: clinicId, patient: patient._id, date: hoy, startTime: '08:00', status: 'pendiente',
  });
}

test('«Asistió» deja escrita la hora a la que entró el paciente', async () => {
  const { clinicId, userId, patient } = await seed();
  const cita = await citaDeHoy(clinicId, patient);

  ok(await H.runController(appointments.markAttended, H.mockReq(clinicId, userId, {}, {
    role: 'cajero', params: { id: String(cita._id) },
  })));

  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.status, 'asistida');
  assert.ok(guardada.arrivedAt, 'quedó sellada la llegada');
  assert.equal(typeof guardada.arrivalDelayMinutes, 'number');
});

test('volver a marcar asistencia NO corre la hora de llegada', async () => {
  const { clinicId, userId, patient } = await seed();
  const cita = await citaDeHoy(clinicId, patient);
  const req = () => H.mockReq(clinicId, userId, {}, { role: 'cajero', params: { id: String(cita._id) } });

  ok(await H.runController(appointments.markAttended, req()));
  const primera = (await Appointment.findById(cita._id).lean()).arrivedAt;

  ok(await H.runController(appointments.markAttended, req()));
  const segunda = (await Appointment.findById(cita._id).lean()).arrivedAt;

  assert.equal(String(primera), String(segunda), 'sigue siendo la hora a la que llegó de verdad');
});

test('repartir la atención también sella la llegada (es recibir al paciente)', async () => {
  const { clinicId, userId, patient } = await seed();
  const cita = await citaDeHoy(clinicId, patient);
  const doctor = await User.create({
    name: 'Dra. Salazar', email: `d${Date.now()}@t.com`, password: 'x12345678',
    role: 'doctor', clinics: [{ clinic: clinicId, role: 'doctor' }],
  });

  ok(await H.runController(appointments.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: String(doctor._id) }],
  }, { role: 'cajero', params: { id: String(cita._id) } })));

  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.status, 'asistida');
  assert.ok(guardada.arrivedAt, 'no hace falta pasar antes por el botón «Asistió»');
});

test('marcar «asistida» desde el formulario de edición sella igual', async () => {
  const { clinicId, userId, patient } = await seed();
  const cita = await citaDeHoy(clinicId, patient);

  ok(await H.runController(appointments.updateAppointment, H.mockReq(clinicId, userId, {
    status: 'asistida',
  }, { role: 'cajero', params: { id: String(cita._id) } })));

  const guardada = await Appointment.findById(cita._id).lean();
  assert.ok(guardada.arrivedAt, 'la cuarta puerta no se puede quedar sin sellar');
  assert.equal(typeof guardada.arrivalDelayMinutes, 'number');
});
