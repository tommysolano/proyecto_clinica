/**
 * Bloqueo de agendamiento en fechas anteriores a hoy. Cubre las tres vías:
 * página de Citas (appointmentController.create/update) y chat/CRM
 * (chatController.createAppointmentFromChat). La reserva pública ya lo bloquea
 * por horizonte en computeSlots.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const appt = require('../controllers/appointmentController');
const chat = require('../controllers/chatController');
const Product = require('../models/Product');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const Appointment = require('../models/Appointment');
const { PAST_DATE_MESSAGE } = require('../utils/appointmentDate');

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const YESTERDAY = ymd(new Date(Date.now() - 86400000));
const TODAY = ymd(new Date());
const TOMORROW = ymd(new Date(Date.now() + 86400000));

async function seedService(clinicId) {
  return Product.create({ clinic: clinicId, code: `S${Date.now()}`, name: 'Consulta', category: 'servicio', salePrice: 50 });
}

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('createAppointment rechaza fecha de ayer y acepta hoy/mañana', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const svc = await seedService(clinicId);
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });

  const body = (date) => ({ patient: patient._id, date, startTime: '09:00', services: [{ product: svc._id }] });

  const past = await H.runController(appt.createAppointment, H.mockReq(clinicId, userId, body(YESTERDAY)));
  assert.equal(past.statusCode, 400, JSON.stringify(past.payload));
  assert.equal(past.payload.message, PAST_DATE_MESSAGE);

  const okToday = await H.runController(appt.createAppointment, H.mockReq(clinicId, userId, body(TODAY)));
  assert.equal(okToday.statusCode, 201, JSON.stringify(okToday.payload));

  const okTomorrow = await H.runController(appt.createAppointment, H.mockReq(clinicId, userId, body(TOMORROW)));
  assert.equal(okTomorrow.statusCode, 201, JSON.stringify(okTomorrow.payload));
});

// ─────────────────────────────────────────────────────────────────────────────
test('updateAppointment bloquea reagendar al pasado pero permite editar cita ya pasada sin moverla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const svc = await seedService(clinicId);
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Leo', lastName: 'G' });
  // Cita existente en el pasado (creada directamente, saltando la validación de creación).
  const existing = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(`${YESTERDAY}T12:00:00`),
    startTime: '10:00', services: [{ product: svc._id, name: 'Consulta' }], status: 'pendiente', createdBy: userId,
  });

  // Reagendar a otra fecha pasada → rechazo.
  const twoDaysAgo = ymd(new Date(Date.now() - 2 * 86400000));
  const reschedPast = await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { date: twoDaysAgo }, { params: { id: String(existing._id) }, role: 'admin' }),
  );
  assert.equal(reschedPast.statusCode, 400, JSON.stringify(reschedPast.payload));

  // Editar (mismo día pasado, cambia la razón) → permitido: no se mueve el día.
  const editSameDay = await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { date: YESTERDAY, reason: 'No-show' }, { params: { id: String(existing._id) }, role: 'admin' }),
  );
  assert.equal(editSameDay.statusCode, 200, JSON.stringify(editSameDay.payload));

  // Reagendar a futuro → permitido.
  const reschedFuture = await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { date: TOMORROW }, { params: { id: String(existing._id) }, role: 'admin' }),
  );
  assert.equal(reschedFuture.statusCode, 200, JSON.stringify(reschedFuture.payload));
});

// ─────────────────────────────────────────────────────────────────────────────
test('createAppointmentFromChat rechaza cita en fecha pasada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const svc = await seedService(clinicId);
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Tom', lastName: 'S', phone: '0999999999' });
  const conv = await Conversation.create({ clinic: clinicId, phone: '593999999999', channel: 'whatsapp', patient: patient._id, lastMessageAt: new Date() });

  const past = await H.runController(
    chat.createAppointmentFromChat,
    H.mockReq(clinicId, userId, { date: YESTERDAY, startTime: '09:00', services: [{ product: svc._id }] }, { params: { id: String(conv._id) } }),
  );
  assert.equal(past.statusCode, 400, JSON.stringify(past.payload));
  assert.match(past.payload.message, /anterior a hoy/);

  const ok = await H.runController(
    chat.createAppointmentFromChat,
    H.mockReq(clinicId, userId, { date: TOMORROW, startTime: '09:00', services: [{ product: svc._id }] }, { params: { id: String(conv._id) } }),
  );
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.payload));
});
