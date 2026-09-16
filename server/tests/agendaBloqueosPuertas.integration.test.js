/**
 * BLOQUEOS DE HORARIO vistos desde las OTRAS puertas de agendamiento.
 *
 * Lo que fijan (sep-2026, a petición del usuario: creó un bloqueo para el día 20
 * de un servicio en una sucursal y el sistema seguía dejando agendar):
 *   1. el LISTADO de bloqueos devuelve el bloqueo del día que se consulta
 *      (el rango se compara en hora LOCAL, no en UTC: con el servidor en
 *      Ecuador, medianoche local es después que medianoche UTC del mismo día y
 *      el `$lte` viejo tiraba el primer día del bloqueo — por eso no se veía
 *      en la vista de lista de la agenda);
 *   2. la puerta del CHAT/CRM, que creaba la cita directo, TAMBIÉN respeta los
 *      bloqueos: general (todo el día) y por servicio del catálogo de la agenda.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
require('../models/Room'); // ref de TimeBlock.room: el populate la necesita registrada
require('../models/User');
const chats = require('../controllers/chatController');
const tb = require('../controllers/timeBlockController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

const manana = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Central' });
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez' });
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593999111222', patient: patient._id, contactName: 'Ana',
  });
  const s1 = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Limpieza', slug: 'limpieza-test', color: '#0ea5e9',
  });
  const s2 = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Ortodoncia', slug: 'ortodoncia-test', color: '#f59e0b',
  });
  return { clinicId, userId, patient, conv, s1, s2 };
}

const pedir = (clinicId, userId, conv, body) =>
  H.mockReq(clinicId, userId, body, { role: 'call_center', params: { id: String(conv._id) } });

/* ── 1. El listado del día devuelve el bloqueo de ese día ─────────────────── */

test('list: un bloqueo del día sale al consultar exactamente ese día', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Central' });
  const dia = manana();
  ok(await H.runController(tb.create, H.mockReq(clinicId, userId, {
    clinic: String(clinicId),
    startDate: dia, endDate: dia,
    allDay: true, reason: 'Mantenimiento',
  })));

  const r = ok(await H.runController(tb.list, H.mockReq(clinicId, userId, {}, {
    query: { startDate: dia, endDate: dia, clinic: String(clinicId) },
  })));
  assert.equal(r.length, 1, `se esperaba el bloqueo del día, llegaron ${r.length}`);
  assert.match(r[0].reason, /Mantenimiento/);
});

/* ── 2. El CRM respeta los bloqueos ──────────────────────────────────────── */

test('CRM: un bloqueo GENERAL del día rechaza la tanda entera, sin crear nada', async () => {
  const { clinicId, userId, conv, patient } = await seed();
  ok(await H.runController(tb.create, H.mockReq(clinicId, userId, {
    clinic: String(clinicId),
    startDate: manana(), endDate: manana(),
    allDay: true, reason: 'Feriado',
  })));

  const r = await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [{ date: manana(), startTime: '09:00' }],
  }));
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /bloqueado/);
  assert.match(r.payload.message, /Feriado/);
  assert.equal(await Appointment.countDocuments({}), 0);
  assert.equal(await Appointment.countDocuments({ patient: patient._id }), 0);
});

test('CRM: un bloqueo por SERVICIO solo bloquea ese servicio', async () => {
  const { clinicId, userId, conv, s1, s2 } = await seed();
  ok(await H.runController(tb.create, H.mockReq(clinicId, userId, {
    clinic: String(clinicId),
    startDate: manana(), endDate: manana(),
    allDay: true,
    service: String(s1._id),
    reason: 'Equipos en mantenimiento',
  })));

  // El servicio bloqueado: rechazado.
  const r1 = await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [{ date: manana(), startTime: '09:00', serviceItem: String(s1._id) }],
  }));
  assert.equal(r1.statusCode, 400, JSON.stringify(r1.payload));
  assert.match(r1.payload.message, /mantenimiento/);

  // OTRO servicio el mismo día: pasa.
  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [{ date: manana(), startTime: '09:00', serviceItem: String(s2._id) }],
  })));
  assert.equal(await Appointment.countDocuments({}), 1);
});

test('CRM: el bloqueo de OTRA sucursal no afecta a esta sede', async () => {
  const { clinicId, userId, conv } = await seed();
  const otra = await Clinic.create({ name: 'Sucursal Norte' });
  ok(await H.runController(tb.create, H.mockReq(clinicId, userId, {
    clinic: String(otra._id),
    startDate: manana(), endDate: manana(),
    allDay: true, reason: 'Cierre en el norte',
  })));

  ok(await H.runController(chats.createAppointmentFromChat, pedir(clinicId, userId, conv, {
    appointments: [{ date: manana(), startTime: '09:00', clinic: String(clinicId) }],
  })));
  assert.equal(await Appointment.countDocuments({}), 1);
});
