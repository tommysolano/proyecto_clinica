/**
 * EL PACIENTE QUE CAMBIÓ DE NÚMERO, LAS CITAS PARA OTRA PERSONA EN EL PANEL DEL
 * CHAT Y LOS VARIOS TELÉFONOS / CORREOS / IDENTIFICACIONES (sep-2026).
 *
 *   1. Un chat se asigna a mano a un paciente ya registrado: el número del chat
 *      se suma a sus otros teléfonos (sin pisar el principal) y a partir de ahí
 *      el chat lo reconoce solo por ese número.
 *   2. Un chat de número oculto (@lid) no guarda el LID como teléfono.
 *   3. El alta desde el chat encuentra al paciente por cualquiera de sus números.
 *   4. La agenda devuelve, para un chat, las citas del paciente Y las agendadas
 *      desde ese chat para otra persona.
 *   5. Otras identificaciones: se limpian, no pueden ser de otro paciente y
 *      quien no ve la cédula no las borra al guardar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const Appointment = require('../models/Appointment');
const chats = require('../controllers/chatController');
const appointments = require('../controllers/appointmentController');
const patients = require('../controllers/patientController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Matriz' });
  // La paciente de siempre, registrada con su número VIEJO.
  const ana = await Patient.create({
    clinic: clinicId, firstName: 'ANA', lastName: 'TORRES', phone: '0991111111', whatsapp: '0991111111',
  });
  // Escribe desde su número NUEVO: el chat no la reconoce.
  const conv = await Conversation.create({ clinic: clinicId, phone: '593982222222', contactName: 'Ana' });
  return { clinicId, userId, ana, conv };
}

const comoCallCenter = (clinicId, userId, conv, body) =>
  H.mockReq(clinicId, userId, body, { role: 'call_center', params: { id: String(conv._id) } });

test('asignar el chat a un paciente registrado guarda el número nuevo y lo reconoce después', async () => {
  const { clinicId, userId, ana, conv } = await seed();

  const res = ok(await H.runController(chats.linkPatientToChat, comoCallCenter(clinicId, userId, conv, {
    patientId: String(ana._id),
  })));
  assert.equal(res.numeroAgregado, true);

  const despues = await Patient.findById(ana._id).lean();
  assert.equal(despues.phone, '0991111111', 'el principal no se pisa');
  assert.deepEqual(despues.otherPhones, ['593982222222'], 'el nuevo queda entre sus otros teléfonos');
  assert.equal(String((await Conversation.findById(conv._id).lean()).patient), String(ana._id));

  // El próximo mensaje desde el número nuevo la reconoce sola.
  const reconocida = await chats.findPatientForIncoming(clinicId, '0982222222');
  assert.equal(String(reconocida?._id), String(ana._id));

  // Asignarlo otra vez no duplica el número.
  ok(await H.runController(chats.linkPatientToChat, comoCallCenter(clinicId, userId, conv, {
    patientId: String(ana._id),
  })));
  assert.equal((await Patient.findById(ana._id).lean()).otherPhones.length, 1);
});

test('un chat de número oculto (@lid) no guarda el LID como teléfono', async () => {
  const { clinicId, userId, ana } = await seed();
  const oculto = await Conversation.create({
    clinic: clinicId, phone: '123456789012345', externalUserId: '123456789012345@lid', contactName: 'Ana',
  });
  const res = ok(await H.runController(chats.linkPatientToChat, comoCallCenter(clinicId, userId, oculto, {
    patientId: String(ana._id),
  })));
  assert.equal(res.numeroAgregado, false);
  assert.deepEqual((await Patient.findById(ana._id).lean()).otherPhones, []);
});

test('el alta desde el chat encuentra al paciente por uno de sus otros números', async () => {
  const { clinicId, userId, ana, conv } = await seed();
  await Patient.updateOne({ _id: ana._id }, { $set: { otherPhones: ['0982222222'] } });

  ok(await H.runController(chats.registerPatientFromChat, comoCallCenter(clinicId, userId, conv, {
    firstName: 'ANA', lastName: 'TORRES',
  })));
  assert.equal(await Patient.countDocuments({}), 1, 'no se abre una ficha duplicada');
  assert.equal(String((await Conversation.findById(conv._id).lean()).patient), String(ana._id));
});

test('las citas de un chat: las del paciente y las agendadas desde ahí para otra persona', async () => {
  const { clinicId, userId, ana, conv } = await seed();
  await Conversation.updateOne({ _id: conv._id }, { $set: { patient: ana._id } });
  const hijo = await Patient.create({ clinic: clinicId, firstName: 'LUCAS', lastName: 'TORRES' });
  const extrano = await Patient.create({ clinic: clinicId, firstName: 'OTRO', lastName: 'PACIENTE' });
  const hoy = new Date();
  hoy.setHours(12, 0, 0, 0);
  const cita = (extra) => Appointment.create({ clinic: clinicId, date: hoy, startTime: '09:00', ...extra });
  const suya = await cita({ patient: ana._id });
  const delHijo = await cita({ patient: hijo._id, conversation: conv._id, startTime: '10:00' });
  await cita({ patient: extrano._id, startTime: '11:00' }); // de nadie de este chat

  const pedir = (query) => H.runController(
    appointments.getAppointments,
    H.mockReq(clinicId, userId, {}, { role: 'call_center', query: { clinic: 'all', ...query } })
  ).then(ok);

  const ambas = await pedir({ patient: String(ana._id), conversation: String(conv._id) });
  assert.deepEqual(ambas.map((a) => String(a._id)).sort(), [String(suya._id), String(delHijo._id)].sort());

  // Sin paciente en el chat: solo las agendadas desde él.
  const soloChat = await pedir({ conversation: String(conv._id) });
  assert.deepEqual(soloChat.map((a) => String(a._id)), [String(delHijo._id)]);

  // Sin `conversation`, como siempre: solo las del paciente.
  const soloPaciente = await pedir({ patient: String(ana._id) });
  assert.deepEqual(soloPaciente.map((a) => String(a._id)), [String(suya._id)]);
});

test('otras identificaciones: se limpian, no pueden ser de otro paciente y quien no las ve no las borra', async () => {
  const { clinicId, userId, ana } = await seed();
  await Patient.create({ clinic: clinicId, firstName: 'PEDRO', cedula: '0102030405' });

  const comoAdmin = (body, params = {}) => H.mockReq(clinicId, userId, body, { role: 'admin', params });

  // La cédula de otro paciente no puede ser «otra identificación» de Ana.
  const choca = await H.runController(patients.updatePatient, comoAdmin(
    { identificationAliases: ['0102030405'] }, { id: String(ana._id) }
  ));
  assert.equal(choca.statusCode, 400);
  assert.match(choca.payload.message, /0102030405/);

  // Limpieza: sin vacíos ni repetidos, y sin repetir el principal.
  ok(await H.runController(patients.updatePatient, comoAdmin({
    cedula: '0911111111',
    identificationAliases: ['0911111111001', '', '0911111111001', '0911111111'],
    phone: '0991111111',
    otherPhones: ['0982222222', '+593 98 222 2222', '0991111111'],
    email: 'ana@correo.com',
    otherEmails: ['ANA.TRABAJO@correo.com', 'ana@correo.com'],
  }, { id: String(ana._id) })));
  const limpia = await Patient.findById(ana._id).lean();
  assert.deepEqual(limpia.identificationAliases, ['0911111111001']);
  assert.deepEqual(limpia.otherPhones, ['0982222222']);
  assert.deepEqual(limpia.otherEmails, ['ana.trabajo@correo.com']);

  // Se la encuentra por el RUC.
  const lista = ok(await H.runController(patients.getPatients, H.mockReq(clinicId, userId, {}, {
    role: 'admin', query: { search: '0911111111001' },
  })));
  assert.equal(lista.patients.length, 1);

  // Marketing no ve identificaciones ni teléfonos: su guardado no las borra.
  ok(await H.runController(patients.updatePatient, H.mockReq(clinicId, userId, {
    firstName: 'ANA MARIA', identificationAliases: [], otherPhones: [],
  }, { role: 'marketing', params: { id: String(ana._id) } })));
  const tras = await Patient.findById(ana._id).lean();
  assert.equal(tras.firstName, 'ANA MARIA');
  assert.deepEqual(tras.identificationAliases, ['0911111111001']);
  assert.deepEqual(tras.otherPhones, ['0982222222']);
});
