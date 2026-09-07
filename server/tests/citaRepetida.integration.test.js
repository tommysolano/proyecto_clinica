/**
 * LA MISMA CITA, DOS VECES (7-sep-2026).
 *
 * En la agenda de mañana aparecían pacientes repetidos: KARINA ARIAS con dos
 * «Biorresonancia» a las 11:30, HUMBERTO MEDINA SALINAS con dos «Eco 360» a las
 * 14:00. Las dos tandas se habían creado desde el chat con 78 y 24 segundos de
 * diferencia, por el mismo usuario y en la misma conversación: quien agenda
 * volvió a abrir la ventana, la rellenó igual y guardó, y el sistema —que no
 * comprobaba nada— creó la tanda entera por segunda vez.
 *
 * Lo que fijan estos tests:
 *   1. no se crea una cita si el paciente ya tiene otra ese día a esa hora;
 *   2. la tanda del chat se comprueba ENTERA antes de crear la primera, así que
 *      un choque no deja media tanda escrita;
 *   3. ni las filas de una misma tanda pueden repetirse entre sí;
 *   4. una cita CANCELADA no ocupa: su hueco vuelve a estar libre;
 *   5. y la regla del doctor —varios pacientes a la misma hora— sigue intacta:
 *      lo único que se cierra es repetir al PACIENTE.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const Appointment = require('../models/Appointment');
const appt = require('../controllers/appointmentController');
const chats = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

/** Mañana: agendar hoy a las 11:30 lo rechazaría la validación de hora pasada. */
const manana = (masDias = 1) => {
  const d = new Date();
  d.setDate(d.getDate() + masDias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function seed() {
  const { clinicId: matriz, userId } = await H.seedClinic();
  await Clinic.create({ _id: matriz, name: 'Matriz' });
  const extension = (await Clinic.create({ name: 'Extension' }))._id;

  const patient = await Patient.create({ clinic: matriz, firstName: 'KARINA', lastName: 'ARIAS' });
  const otro = await Patient.create({ clinic: matriz, firstName: 'HUMBERTO', lastName: 'MEDINA' });
  const conv = await Conversation.create({
    clinic: matriz, phone: '593982201838', patient: patient._id, contactName: 'Karina',
  });
  return { matriz, extension, userId, patient, otro, conv };
}

/** Alta de cita por la página de Citas. */
const crear = (matriz, userId, patient, extra = {}) =>
  H.runController(
    appt.createAppointment,
    H.mockReq(matriz, userId, {
      patient: String(patient._id),
      date: manana(),
      startTime: '11:30',
      ...extra,
    })
  );

/** Alta de tanda por el chat. */
const crearDesdeChat = (matriz, userId, conv, filas) =>
  H.runController(
    chats.createAppointmentFromChat,
    H.mockReq(matriz, userId, { appointments: filas }, {
      role: 'call_center',
      params: { id: String(conv._id) },
    })
  );

// ─────────────────────── 1. la puerta de la página de Citas ───────────────────

test('no se agenda al mismo paciente dos veces en la misma hora', async () => {
  const { matriz, userId, patient } = await seed();

  ok(await crear(matriz, userId, patient));
  const segunda = await crear(matriz, userId, patient);

  assert.equal(segunda.statusCode, 409, JSON.stringify(segunda.payload));
  assert.equal(segunda.payload.code, 'APPOINTMENT_DUPLICATE');
  assert.match(segunda.payload.message, /ya tiene una cita/i);
  assert.equal(await Appointment.countDocuments({}), 1, 'sigue habiendo una sola');
});

test('el aviso dice CUÁL es la cita que ya existe (día, hora y servicio)', async () => {
  const { matriz, userId, patient } = await seed();

  const primera = ok(await crear(matriz, userId, patient));
  await Appointment.updateOne({ _id: primera._id }, { $set: { serviceName: 'Biorresonancia' } });

  const segunda = await crear(matriz, userId, patient);
  assert.match(segunda.payload.message, /11:30/);
  assert.match(segunda.payload.message, /Biorresonancia/);
  assert.equal(segunda.payload.appointmentId, String(primera._id), 'y apunta a la que ya estaba');
});

test('otra hora del mismo día sí se agenda: no se está bloqueando el día entero', async () => {
  const { matriz, userId, patient } = await seed();

  ok(await crear(matriz, userId, patient));
  ok(await crear(matriz, userId, patient, { startTime: '12:00' }));
  assert.equal(await Appointment.countDocuments({}), 2);
});

test('y a OTRO paciente a la misma hora también: el hueco no es exclusivo', async () => {
  const { matriz, userId, patient, otro } = await seed();

  ok(await crear(matriz, userId, patient));
  ok(await crear(matriz, userId, otro));
  assert.equal(await Appointment.countDocuments({}), 2, 'dos pacientes a las 11:30 es normal');
});

test('tampoco cabe en OTRA sucursal: el paciente no está en dos sedes a la vez', async () => {
  const { matriz, extension, userId, patient } = await seed();

  ok(await crear(matriz, userId, patient));
  const segunda = await crear(matriz, userId, patient, { clinic: String(extension) });

  assert.equal(segunda.statusCode, 409, JSON.stringify(segunda.payload));
  assert.equal(await Appointment.countDocuments({}), 1);
});

test('una cita CANCELADA libera el hueco', async () => {
  const { matriz, userId, patient } = await seed();

  const primera = ok(await crear(matriz, userId, patient));
  await Appointment.updateOne({ _id: primera._id }, { $set: { status: 'cancelada' } });

  ok(await crear(matriz, userId, patient));
  assert.equal(await Appointment.countDocuments({ status: { $ne: 'cancelada' } }), 1);
});

// ─────────────────────── 2. la puerta del chat (el caso real) ─────────────────

test('la tanda del chat no se puede guardar dos veces (KARINA ARIAS)', async () => {
  const { matriz, userId, conv } = await seed();
  const filas = [
    { date: manana(), startTime: '11:30' },
    { date: manana(), startTime: '12:00' },
  ];

  ok(await crearDesdeChat(matriz, userId, conv, filas));
  assert.equal(await Appointment.countDocuments({}), 2);

  // Minuto y medio después, la misma tanda otra vez —con el motivo escrito en
  // una fila, que es lo que pasó de verdad—.
  const repetida = await crearDesdeChat(matriz, userId, conv, [
    { date: manana(), startTime: '11:30' },
    { date: manana(), startTime: '12:00', reason: 'LABORATORIO' },
  ]);

  assert.equal(repetida.statusCode, 409, JSON.stringify(repetida.payload));
  assert.equal(await Appointment.countDocuments({}), 2, 'siguen siendo dos, no cuatro');
});

test('si UNA fila de la tanda ya existe, no se crea NINGUNA', async () => {
  const { matriz, userId, conv } = await seed();

  ok(await crearDesdeChat(matriz, userId, conv, [{ date: manana(), startTime: '11:30' }]));

  // La primera fila choca; la segunda y la tercera son nuevas. No debe quedar
  // media tanda escrita: se comprueba todo antes de crear nada.
  const r = await crearDesdeChat(matriz, userId, conv, [
    { date: manana(), startTime: '11:30' },
    { date: manana(), startTime: '15:00' },
    { date: manana(), startTime: '16:00' },
  ]);

  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  assert.match(r.payload.message, /La cita #1/);
  assert.equal(await Appointment.countDocuments({}), 1, 'ni la #2 ni la #3 se crearon');
});

test('dos filas iguales dentro de la MISMA tanda se rechazan', async () => {
  const { matriz, userId, conv } = await seed();

  const r = await crearDesdeChat(matriz, userId, conv, [
    { date: manana(), startTime: '14:00' },
    { date: manana(), startTime: '14:00' },
  ]);

  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /#1 y #2 son la misma/);
  assert.equal(await Appointment.countDocuments({}), 0);
});

test('la tanda con horas distintas se crea entera (HUMBERTO: 14:00 y 14:20)', async () => {
  const { matriz, userId, conv } = await seed();

  ok(await crearDesdeChat(matriz, userId, conv, [
    { date: manana(), startTime: '14:00' },
    { date: manana(), startTime: '14:20' },
  ]));
  assert.equal(await Appointment.countDocuments({}), 2);
});

// ─────────────────────── 3. reagendar ─────────────────────────────────────────

test('reagendar no puede pisar otra cita del mismo paciente', async () => {
  const { matriz, userId, patient } = await seed();

  ok(await crear(matriz, userId, patient));                                // 11:30
  const doce = ok(await crear(matriz, userId, patient, { startTime: '12:00' }));

  const r = await H.runController(
    appt.updateAppointment,
    H.mockReq(matriz, userId, { startTime: '11:30' }, { params: { id: String(doce._id) } })
  );

  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  const sinTocar = await Appointment.findById(doce._id).lean();
  assert.equal(sinTocar.startTime, '12:00', 'la cita se queda donde estaba');
});

test('guardar otra cosa de la cita no la hace chocar consigo misma', async () => {
  const { matriz, userId, patient } = await seed();

  const cita = ok(await crear(matriz, userId, patient));
  const r = await H.runController(
    appt.updateAppointment,
    H.mockReq(matriz, userId, { reason: 'Trae exámenes' }, { params: { id: String(cita._id) } })
  );

  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  assert.equal((await Appointment.findById(cita._id).lean()).reason, 'Trae exámenes');
});

test('mover una cita a un hueco libre sigue funcionando', async () => {
  const { matriz, userId, patient } = await seed();

  const cita = ok(await crear(matriz, userId, patient));
  const r = await H.runController(
    appt.updateAppointment,
    H.mockReq(matriz, userId, { startTime: '16:00' }, { params: { id: String(cita._id) } })
  );

  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  assert.equal((await Appointment.findById(cita._id).lean()).startTime, '16:00');
});
