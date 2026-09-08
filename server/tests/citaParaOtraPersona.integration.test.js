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
const ClinicalRecord = require('../models/ClinicalRecord');
const chats = require('../controllers/chatController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

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
  return { clinicId, userId, contacto, esposo, conv };
}

const pedir = (clinicId, userId, conv, body) =>
  H.mockReq(clinicId, userId, body, { role: 'call_center', params: { id: String(conv._id) } });

test('la cita queda a nombre de la otra persona, no de quien escribe', async () => {
  const { clinicId, userId, contacto, esposo, conv } = await seed();

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    patientId: String(esposo._id),
    appointments: [{ date: manana(), startTime: '09:00' }],
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
    appointments: [{ date: manana(), startTime: '10:00' }],
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
    appointments: [{ date: manana(), startTime: '11:00' }],
  })));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(cita.isFirstVisit, false, 'el que viene no es nuevo, aunque ella sí lo sea');
});

test('un paciente que no existe no cuela', async () => {
  const { clinicId, userId, conv } = await seed();
  const inventado = new H.mongoose.Types.ObjectId();

  const r = await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    patientId: String(inventado),
    appointments: [{ date: manana(), startTime: '12:00' }],
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
    appointments: [{ date: manana(), startTime: '13:00' }],
  })));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(String(cita.patient), String(esposo._id));

  // Y sin paciente ninguno sigue sin poderse: no hay a quién agendar.
  const r = await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, suelto, {
    appointments: [{ date: manana(), startTime: '14:00' }],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
});
