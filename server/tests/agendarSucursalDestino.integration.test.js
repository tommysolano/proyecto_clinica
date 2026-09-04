/**
 * AGENDAR EN OTRA SUCURSAL: quién puede y quién no.
 *
 * El call center no trabaja EN una sucursal: agenda para la clínica entera, en
 * la sede que le pida el paciente por teléfono o por WhatsApp. Estaba fuera de
 * `veTodaLaOrganizacion` y, como además suele tener UNA sola sucursal asignada,
 * al agendar desde el chat el selector de sucursal ni le aparecía: sus citas
 * caían siempre en su sede.
 *
 * Y de paso se cierra el agujero contrario: el alta desde el chat cogía la
 * sucursal del cuerpo de la petición SIN COMPROBAR NADA, así que cualquier rol
 * podía agendar en una sede a la que no llega cambiando un id.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const Appointment = require('../models/Appointment');
const chats = require('../controllers/chatController');
const clinicCtrl = require('../controllers/clinicController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function seed() {
  const { clinicId: matriz, userId } = await H.seedClinic();
  await Clinic.create({ _id: matriz, name: 'Matriz' });
  const extension = (await Clinic.create({ name: 'Extension' }))._id;

  const patient = await Patient.create({ clinic: matriz, firstName: 'JIMMY', lastName: 'ROA' });
  const conv = await Conversation.create({
    clinic: matriz, phone: '593999999999', patient: patient._id, contactName: 'Jimmy',
  });
  return { matriz, extension, userId, conv, patient };
}

/** Mañana: agendar hoy a las 09:00 lo rechaza la validación de hora pasada. */
const manana = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
};

test('el call center agenda en OTRA sucursal desde el chat', async () => {
  const { matriz, extension, userId, conv } = await seed();

  const req = H.mockReq(matriz, userId, {
    appointments: [{ date: manana(), startTime: '09:00', clinic: String(extension) }],
  }, { role: 'call_center', params: { id: String(conv._id) } });
  // Asignado a UNA sola sede, como en la clínica: aun así agenda en la otra.
  req.user.clinics = [{ clinic: matriz, role: 'call_center' }];
  const r = ok(await H.runController(chats.createAppointmentFromChat, req));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(String(cita.clinic), String(extension), 'la cita queda en la sucursal que se escogió');
  assert.equal(cita.createdByRole, 'call_center');
});

test('y también recibe la lista de sucursales para poder escogerla', async () => {
  const { matriz, userId } = await seed();
  const req = H.mockReq(matriz, userId, {}, { role: 'call_center', query: { scope: 'names' } });
  req.user.clinics = [{ clinic: matriz, role: 'call_center' }];

  const lista = ok(await H.runController(clinicCtrl.getClinics, req));
  assert.equal(lista.length, 2, 'las dos sedes de la organización, no solo la suya');
});

/**
 * La sede destino NO se filtra por rol: quién agenda ya lo decide la ruta, y
 * dentro la sucursal es un dato de la cita. Marketing agenda desde el chat (ver
 * CALL_CENTER_ROLES en routes/chats.js) y también tiene que poder escogerla.
 */
test('cualquiera que pueda agendar escoge la sede, no solo quien ve toda la organización', async () => {
  const { matriz, extension, userId, conv } = await seed();

  const req = H.mockReq(matriz, userId, {
    appointments: [{ date: manana(), startTime: '09:00', clinic: String(extension) }],
  }, { role: 'marketing', params: { id: String(conv._id) } });
  req.user.clinics = [{ clinic: matriz, role: 'marketing' }];

  ok(await H.runController(chats.createAppointmentFromChat, req));
  const cita = await Appointment.findOne({}).lean();
  assert.equal(String(cita.clinic), String(extension));
});

test('una sucursal inexistente o dada de baja se rechaza', async () => {
  const { matriz, userId, conv } = await seed();
  const baja = (await Clinic.create({ name: 'Cerrada', active: false }))._id;

  const req = H.mockReq(matriz, userId, {
    appointments: [{ date: manana(), startTime: '09:00', clinic: String(baja) }],
  }, { role: 'call_center', params: { id: String(conv._id) } });
  req.user.clinics = [{ clinic: matriz, role: 'call_center' }];

  const r = await H.runController(chats.createAppointmentFromChat, req);
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.equal(await Appointment.countDocuments({}), 0);
});

test('sin sucursal en el cuerpo se sigue agendando en la propia', async () => {
  const { matriz, userId, conv } = await seed();
  const req = H.mockReq(matriz, userId, {
    appointments: [{ date: manana(), startTime: '09:00' }],
  }, { role: 'call_center', params: { id: String(conv._id) } });
  req.user.clinics = [{ clinic: matriz, role: 'call_center' }];

  ok(await H.runController(chats.createAppointmentFromChat, req));
  const cita = await Appointment.findOne({}).lean();
  assert.equal(String(cita.clinic), String(matriz));
});

/**
 * EL VALOR Y EL PAGO ADELANTADO, DESDE EL CHAT.
 *
 * El call center cierra la cita por teléfono y cobra en el momento: puede abonar
 * para reservar o pagarla entera. Antes eso no cabía en ningún campo —el alta
 * desde el chat ni miraba el importe— y acababa escrito en el motivo de la cita,
 * donde no lo lee ningún reporte y mostrador no lo ve al recibir al paciente.
 */
test('el call center agenda cobrando: valor y abono quedan en la cita', async () => {
  const { matriz, userId, conv } = await seed();

  const req = H.mockReq(matriz, userId, {
    appointments: [{
      date: manana(), startTime: '09:00',
      agreedValue: 90, advancePayment: 'abono', advanceAmount: 25,
    }],
  }, { role: 'call_center', params: { id: String(conv._id) } });
  req.user.clinics = [{ clinic: matriz, role: 'call_center' }];
  ok(await H.runController(chats.createAppointmentFromChat, req));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(cita.agreedValue, 90, 'lo que se acordó por teléfono');
  assert.equal(cita.advancePayment, 'abono');
  assert.equal(cita.advanceAmount, 25, 'lo que dejó pagado para reservar');
  assert.equal(cita.paidInAdvance, true, 'el espejo que lee el Excel de citas');
});

test('«pagó todo» desde el chat deja pagado el valor de la cita', async () => {
  const { matriz, userId, conv } = await seed();

  const req = H.mockReq(matriz, userId, {
    appointments: [{ date: manana(), startTime: '09:00', agreedValue: 60, advancePayment: 'total' }],
  }, { role: 'call_center', params: { id: String(conv._id) } });
  req.user.clinics = [{ clinic: matriz, role: 'call_center' }];
  ok(await H.runController(chats.createAppointmentFromChat, req));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(cita.advancePayment, 'total');
  assert.equal(cita.advanceAmount, 60, 'al llegar no hay que cobrarle nada');
});

test('marketing agenda desde el chat, pero el importe no es suyo', async () => {
  const { matriz, userId, conv } = await seed();

  const req = H.mockReq(matriz, userId, {
    appointments: [{ date: manana(), startTime: '09:00', agreedValue: 90, advancePayment: 'total' }],
  }, { role: 'marketing', params: { id: String(conv._id) } });
  req.user.clinics = [{ clinic: matriz, role: 'marketing' }];
  ok(await H.runController(chats.createAppointmentFromChat, req));

  const cita = await Appointment.findOne({}).lean();
  assert.equal(cita.agreedValue ?? null, null, 'la cita se agenda, el precio no se cuela');
  assert.equal(cita.advancePayment, '');
});
