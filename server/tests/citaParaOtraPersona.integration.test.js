/**
 * AGENDAR DESDE EL CHAT PARA OTRA PERSONA (sep-2026).
 *
 * Pasa a diario en el call center: la paciente de siempre escribe para pedir
 * hora «para mi esposo», o una hija agenda por su madre. Hasta ahora este
 * endpoint solo conocía un paciente —el del chat— así que esas citas quedaban a
 * nombre de quien escribió: en el mostrador aparecía alguien que no era el de la
 * agenda y la consulta se escribía en la ficha equivocada, que es un error que no
 * se deshace.
 *
 * Lo que fijan estos tests:
 *   1. con `patientId` la cita queda a nombre del OTRO paciente;
 *   2. el chat sigue siendo el origen (`conversation`), que es de lo que vive el
 *      panel de Supervisión;
 *   3. «nuevo» se decide sobre quien de verdad viene, no sobre quien escribe;
 *   4. y un id inventado no cuela.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const ClinicalRecord = require('../models/ClinicalRecord');
const chats = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

/** El servicio obligatorio que crea el seed; lo usan todas las filas. */
let SERVICIO = null;

/** Mañana: agendar hoy a las 09:00 lo rechaza la validación de hora pasada. */
const manana = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Matriz' });
  const contacto = await Patient.create({ clinic: clinicId, firstName: 'MARIA', lastName: 'PEREZ' });
  const esposo = await Patient.create({ clinic: clinicId, firstName: 'JUAN', lastName: 'PEREZ' });
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593999999999', patient: contacto._id, contactName: 'Maria',
  });
  // El servicio es obligatorio desde sep-2026: toda cita de estos tests lo lleva.
  SERVICIO = await AppointmentServiceItem.create({ clinic: clinicId, name: 'Consulta', slug: 'consulta' });
  return { clinicId, userId, contacto, esposo, conv };
}

const pedir = (clinicId, userId, conv, body) =>
  H.mockReq(clinicId, userId, body, { role: 'call_center', params: { id: String(conv._id) } });

test('la cita queda a nombre de la otra persona, no de quien escribe', async () => {
  const { clinicId, userId, contacto, esposo, conv } = await seed();

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    patientId: String(esposo._id),
    appointments: [{ date: manana(), startTime: '09:00', serviceItem: String(SERVICIO._id) }],
  })));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(String(cita.patient), String(esposo._id), 'viene el esposo');
  assert.notEqual(String(cita.patient), String(contacto._id));
  assert.equal(String(cita.conversation), String(conv._id), 'el chat sigue siendo el origen');
  assert.match(cita.reason, /Maria/, 'el motivo dice desde qué chat se pidió');
});

test('sin `patientId` se sigue agendando para el contacto, como siempre', async () => {
  const { clinicId, userId, contacto, conv } = await seed();

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [{ date: manana(), startTime: '10:00', serviceItem: String(SERVICIO._id) }],
  })));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(String(cita.patient), String(contacto._id));
});

test('«paciente nuevo» se decide sobre quien viene, no sobre quien escribe', async () => {
  const { clinicId, userId, contacto, esposo, conv } = await seed();
  // El esposo lleva años viniendo (su historia está escrita); ella nunca ha venido.
  await ClinicalRecord.create({
    clinic: clinicId,
    patient: esposo._id,
    createdBy: userId,
    followUps: [{ fecha: new Date(), motivoConsulta: 'control', createdBy: userId }],
  });

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    patientId: String(esposo._id),
    appointments: [{ date: manana(), startTime: '11:00', serviceItem: String(SERVICIO._id) }],
  })));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(cita.isFirstVisit, false, 'el que viene no es nuevo, aunque ella sí lo sea');
});

test('un paciente que no existe no cuela', async () => {
  const { clinicId, userId, conv } = await seed();
  const inventado = new H.mongoose.Types.ObjectId();

  const r = await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    patientId: String(inventado),
    appointments: [{ date: manana(), startTime: '12:00', serviceItem: String(SERVICIO._id) }],
  }));

  assert.equal(r.statusCode, 404, JSON.stringify(r.payload));
  assert.equal(await Appointment.countDocuments({}), 0);
});

test('se puede agendar para otra persona aunque el chat no esté vinculado a nadie', async () => {
  const { clinicId, userId, esposo } = await seed();
  const suelto = await Conversation.create({
    clinic: clinicId, phone: '593988888888', contactName: 'Número nuevo',
  });

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, suelto, {
    patientId: String(esposo._id),
    appointments: [{ date: manana(), startTime: '13:00', serviceItem: String(SERVICIO._id) }],
  })));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(String(cita.patient), String(esposo._id));

  // Y sin paciente ninguno sigue sin poderse: no hay a quién agendar.
  const r = await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, suelto, {
    appointments: [{ date: manana(), startTime: '14:00', serviceItem: String(SERVICIO._id) }],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
});

/* ─────────────────────────────────────────────────────────────────────────────
 * UNA TANDA, VARIAS PERSONAS (sep-2026)
 *
 * El destinatario dejó de ser de la tanda y pasó a ser de CADA CITA: la madre
 * que llama pide hora para ella y para el niño en la misma llamada. Y con él la
 * sucursal, que se preguntaba una sola vez para todas —la segunda cita se iba a
 * la sede de la primera sin que nadie lo viera—.
 * ────────────────────────────────────────────────────────────────────────── */

test('una tanda puede repartirse entre el contacto y otra persona', async () => {
  const { clinicId, userId, contacto, esposo, conv } = await seed();

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [
      // Sin `patientId`: para quien escribe.
      { date: manana(), startTime: '09:00', serviceItem: String(SERVICIO._id) },
      // Con `patientId`: para el marido, en la misma llamada.
      { date: manana(), startTime: '09:30', serviceItem: String(SERVICIO._id), patientId: String(esposo._id) },
    ],
  })));

  const citas = await Appointment.find({}).sort({ startTime: 1 }).lean();
  assert.equal(citas.length, 2);
  assert.equal(String(citas[0].patient), String(contacto._id), 'la de las 9 es de ella');
  assert.equal(String(citas[1].patient), String(esposo._id), 'la de las 9:30 es de él');
  // El chat es el origen de las dos: Supervisión las cuenta igual.
  citas.forEach((c) => assert.equal(String(c.conversation), String(conv._id)));
  // Y solo la del tercero lleva el motivo que dice de qué chat salió.
  assert.match(citas[1].reason, /Maria/);
  assert.doesNotMatch(citas[0].reason, /Cita pedida desde el chat/);
});

test('«paciente nuevo» se resuelve por persona, no una vez para la tanda', async () => {
  const { clinicId, userId, contacto, esposo, conv } = await seed();
  // Ella lleva años viniendo; el marido no ha pisado la clínica.
  await ClinicalRecord.create({
    clinic: clinicId,
    patient: contacto._id,
    createdBy: userId,
    followUps: [{ fecha: new Date(), motivoConsulta: 'control', createdBy: userId }],
  });

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [
      { date: manana(), startTime: '09:00', serviceItem: String(SERVICIO._id) },
      { date: manana(), startTime: '09:30', serviceItem: String(SERVICIO._id), patientId: String(esposo._id) },
    ],
  })));

  const citas = await Appointment.find({}).sort({ startTime: 1 }).lean();
  assert.equal(citas[0].isFirstVisit, false, 'ella ya tiene historia');
  assert.equal(citas[1].isFirstVisit, true, 'él sí es nuevo: no hereda la respuesta de ella');
});

test('la primera de cada persona es la única «nueva» de esa persona', async () => {
  const { clinicId, userId, contacto, esposo, conv } = await seed();

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [
      { date: manana(), startTime: '09:00', serviceItem: String(SERVICIO._id) },
      { date: manana(), startTime: '09:30', serviceItem: String(SERVICIO._id), patientId: String(esposo._id) },
      { date: manana(), startTime: '10:00', serviceItem: String(SERVICIO._id) },
      { date: manana(), startTime: '10:30', serviceItem: String(SERVICIO._id), patientId: String(esposo._id) },
    ],
  })));

  const porPaciente = (id) => Appointment.find({ patient: id }).sort({ startTime: 1 }).lean();
  for (const id of [contacto._id, esposo._id]) {
    const suyas = await porPaciente(id);
    assert.equal(suyas.length, 2);
    assert.equal(suyas[0].isFirstVisit, true);
    assert.equal(suyas[1].isFirstVisit, false, 'la segunda de esa persona ya no es la primera');
  }
});

test('cada cita va a SU sucursal', async () => {
  const { clinicId, userId, esposo, conv } = await seed();
  const otraSede = await Clinic.create({ name: 'Sucursal Norte' });

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [
      { date: manana(), startTime: '09:00', serviceItem: String(SERVICIO._id), clinic: String(clinicId) },
      { date: manana(), startTime: '09:30', serviceItem: String(SERVICIO._id), patientId: String(esposo._id), clinic: String(otraSede._id) },
    ],
  })));

  const citas = await Appointment.find({}).sort({ startTime: 1 }).lean();
  assert.equal(String(citas[0].clinic), String(clinicId));
  assert.equal(String(citas[1].clinic), String(otraSede._id), 'la segunda NO hereda la sede de la primera');
});

test('dos personas distintas SÍ caben en la misma hora; la misma persona no', async () => {
  const { clinicId, userId, esposo, conv } = await seed();

  // Madre e hijo a la misma hora: son dos personas, es normal.
  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [
      { date: manana(), startTime: '09:00', serviceItem: String(SERVICIO._id) },
      { date: manana(), startTime: '09:00', serviceItem: String(SERVICIO._id), patientId: String(esposo._id) },
    ],
  })));
  assert.equal(await Appointment.countDocuments({}), 2);

  // La MISMA persona dos veces en el mismo hueco sigue bloqueada.
  const r = await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [
      { date: manana(), startTime: '15:00', serviceItem: String(SERVICIO._id), patientId: String(esposo._id) },
      { date: manana(), startTime: '15:00', serviceItem: String(SERVICIO._id), patientId: String(esposo._id) },
    ],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /son la misma/);
  assert.equal(await Appointment.countDocuments({}), 2, 'no se creó ninguna de las dos');
});

test('un id inventado en UNA fila tumba la tanda entera, sin crear nada', async () => {
  const { clinicId, userId, conv } = await seed();
  const inventado = new H.mongoose.Types.ObjectId();

  const r = await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [
      { date: manana(), startTime: '09:00', serviceItem: String(SERVICIO._id) },
      { date: manana(), startTime: '09:30', serviceItem: String(SERVICIO._id), patientId: String(inventado) },
    ],
  }));

  assert.equal(r.statusCode, 404, JSON.stringify(r.payload));
  assert.equal(await Appointment.countDocuments({}), 0, 'ni siquiera la primera, que era válida');
});
