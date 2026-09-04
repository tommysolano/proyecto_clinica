/**
 * CERRAR Y EDITAR UNA CITA: dos cosas que reportó la clínica el mismo día.
 *
 * 1. UN DOCTOR SE QUEDÓ SIN PODER VOLVER A SU CONSULTA. Le dio al botón de
 *    finalizar y la cita se cerró; después no le aparecía «Ver / corregir».
 *    La causa: `endConsultation` ponía `status = 'completada'` y dejaba SU TURNO
 *    en «pendiente». La cita quedaba en un estado que no existe —cerrada y con
 *    la pelota todavía en manos de alguien— y la pantalla, que decide con los
 *    turnos, no le ofrecía volver (para ella la cita seguía siendo suya) ni
 *    atender (estaba completada). Guardar el seguimiento sí lo hacía bien; esta
 *    puerta se lo saltaba.
 *
 * 2. EL DOCTOR PODÍA EDITAR LA CITA. Tenía el lápiz en su agenda y con él el
 *    formulario entero: fecha, hora, servicio, paciente y precio. Venía de
 *    cuando esta ruta era también por donde se atendía. Hoy la consulta va por
 *    `/start` y `/end` y lo escrito va a la ficha: editar la cita es de
 *    mostrador.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const appt = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const params = (id) => ({ params: { id: String(id) } });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez' });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });
  const docA = await crear('DocA', 'doctor');
  const docB = await crear('DocB', 'ginecologia');

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });
  return { clinicId, userId, patient, docA, docB, cita };
}

const asignar = (clinicId, userId, citaId, doctores) =>
  H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: doctores.map(String) }, params(citaId)),
  );

const finalizar = (clinicId, quien, citaId, role = 'doctor') =>
  H.runController(appt.endConsultation, H.mockReq(clinicId, quien, {}, { role, ...params(citaId) }));

// ─────────────────── 1. Finalizar cierra el turno ───────────────────

test('C1) finalizar la consulta CIERRA el turno del doctor, no solo la cita', async () => {
  const { clinicId, userId, docA, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [docA._id]));

  ok(await finalizar(clinicId, docA._id, cita._id));

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'completada');
  // Esto es lo que faltaba: sin el turno cerrado, la pantalla creía que la cita
  // seguía en manos del doctor y no le ofrecía volver a entrar.
  assert.equal(guardada.turns[0].status, 'completado', 'el turno queda cerrado');
  assert.equal(String(guardada.turns[0].user), String(docA._id));
  assert.equal(guardada.currentTurnUser, null, 'ya no la tiene nadie');
  assert.equal(guardada.currentTurnKind, null);
  // Y el espejo sigue apuntando a quien atendió: de ahí salen las comisiones.
  assert.equal(String(guardada.doctor), String(docA._id));
});

test('C2) con otro profesional detrás, finalizar PASA la cita, no la cierra', async () => {
  const { clinicId, userId, docA, docB, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [docA._id, docB._id]));

  ok(await finalizar(clinicId, docA._id, cita._id));

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'asistida', 'sigue abierta: falta el segundo doctor');
  assert.equal(guardada.turns[0].status, 'completado');
  assert.equal(guardada.turns[1].status, 'pendiente');
  assert.equal(String(guardada.currentTurnUser), String(docB._id), 'la pelota pasa al segundo');
  assert.equal(String(guardada.doctor), String(docB._id), 'y el espejo con ella');
});

test('C3) una cita SIN turnos se cierra igual que siempre', async () => {
  const { clinicId, docA, cita } = await seed();
  // Cita antigua: doctor puesto a mano, sin cola de turnos.
  await Appointment.updateOne({ _id: cita._id }, { $set: { doctor: docA._id, status: 'asistida' } });

  ok(await finalizar(clinicId, docA._id, cita._id));

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'completada');
  assert.ok(guardada.consultationEndedAt, 'y con su hora de fin');
});

/**
 * EL DOBLE CLIC, que es como se descubrió todo esto. Dos clics seguidos mandan
 * dos peticiones: la segunda no puede llevarse por delante el turno del
 * profesional que viene detrás.
 */
test('C4) darle dos veces a finalizar no se lleva por delante el turno del siguiente', async () => {
  const { clinicId, userId, docA, docB, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [docA._id, docB._id]));

  ok(await finalizar(clinicId, docA._id, cita._id));
  // Tras el primero, la cita ya es del segundo doctor y el espejo lo dice: el
  // segundo clic del primero se rechaza sin tocar nada.
  const segundo = await finalizar(clinicId, docA._id, cita._id);
  assert.equal(segundo.statusCode, 403, JSON.stringify(segundo.payload));

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'asistida', 'el paciente sigue esperando al segundo doctor');
  assert.equal(guardada.turns[1].status, 'pendiente');
});

/**
 * Y el mismo doble clic en una cita de UN SOLO doctor: la segunda petición no
 * puede dejar la cita en un estado raro ni desasignar a quien atendió. (Este es,
 * literalmente, el caso que se reportó: «le dio doble clic y la cita se cerró».)
 */
test('C5) doble clic con un solo doctor: la cita queda cerrada y bien cerrada', async () => {
  const { clinicId, userId, docA, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [docA._id]));

  ok(await finalizar(clinicId, docA._id, cita._id));
  ok(await finalizar(clinicId, docA._id, cita._id));

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'completada');
  assert.equal(guardada.turns.length, 1, 'no aparece un turno de más');
  assert.equal(guardada.turns[0].status, 'completado');
  assert.equal(String(guardada.doctor), String(docA._id), 'sigue siendo su consulta');
});

// ─────────────────── 2. La cita la edita mostrador ───────────────────

const editar = (clinicId, quien, citaId, role, body) =>
  H.runController(appt.updateAppointment, H.mockReq(clinicId, quien, body, { role, ...params(citaId) }));

test('C6) el doctor asignado NO puede editar la cita', async () => {
  const { clinicId, userId, docA, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [docA._id]));

  const r = await editar(clinicId, docA._id, cita._id, 'doctor', { startTime: '17:00' });
  assert.equal(r.statusCode, 403, JSON.stringify(r.payload));
  assert.equal(r.payload.code, 'APPOINTMENT_EDIT_FRONT_DESK');
  assert.equal((await Appointment.findById(cita._id)).startTime, '10:00', 'la hora no se movió');
});

test('C7) tampoco la que él mismo creó (atención sin cita)', async () => {
  const { clinicId, docA, patient } = await seed();
  const suya = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(1), startTime: '11:00',
    status: 'asistida', createdBy: docA._id, doctor: docA._id,
  });

  const r = await editar(clinicId, docA._id, suya._id, 'doctor', { startTime: '18:00' });
  assert.equal(r.statusCode, 403, 'crearla no le da derecho a reescribirla');
});

test('C8) enfermería tampoco', async () => {
  const { clinicId, cita } = await seed();
  const enf = await User.create({
    name: 'Enf', email: 'enf@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  const r = await editar(clinicId, enf._id, cita._id, 'enfermero', { startTime: '18:00' });
  assert.equal(r.statusCode, 403);
});

test('C9) mostrador y administración sí, como siempre', async () => {
  const { clinicId, userId, patient } = await seed();
  // Una cita de MAÑANA: cambiarle la hora a una que ya pasó lo rechaza la
  // validación de fecha pasada, que es otra regla y no la que se prueba aquí.
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(1), startTime: '10:00', status: 'pendiente',
  });

  ok(await editar(clinicId, userId, cita._id, 'cajero', { startTime: '11:20' }));
  assert.equal((await Appointment.findById(cita._id)).startTime, '11:20');

  ok(await editar(clinicId, userId, cita._id, 'admin', { startTime: '11:40' }));
  assert.equal((await Appointment.findById(cita._id)).startTime, '11:40');

  // El call center reagenda desde el chat.
  ok(await editar(clinicId, userId, cita._id, 'call_center', { startTime: '12:00' }));
  assert.equal((await Appointment.findById(cita._id)).startTime, '12:00');
});
