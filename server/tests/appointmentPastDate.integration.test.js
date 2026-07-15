/**
 * Bloqueo de agendamiento en fechas/horas pasadas. Cubre las tres vías:
 * página de Citas (appointmentController.create/update) y chat/CRM
 * (chatController.createAppointmentFromChat). La reserva pública ya lo bloquea
 * por horizonte + filtro de slots pasados en computeSlots.
 *
 * Regla: ni días anteriores a hoy, ni HOY en una hora anterior a la actual
 * (hora Ecuador). Los casos de "hoy" dependen del reloj real, así que se
 * calculan horas relativas y se omiten en los minutos extremos del día.
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
const { PAST_DATE_MESSAGE, PAST_TIME_MESSAGE } = require('../utils/appointmentDate');

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function hhmm(d) {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
const YESTERDAY = ymd(new Date(Date.now() - 86400000));
const TODAY = ymd(new Date());
const TOMORROW = ymd(new Date(Date.now() + 86400000));

/** 'HH:MM' a offsetMin de ahora, solo si sigue siendo HOY (null si cruza de día). */
function timeToday(offsetMin) {
  const d = new Date(Date.now() + offsetMin * 60000);
  return ymd(d) === TODAY ? hhmm(d) : null;
}

async function seedService(clinicId) {
  return Product.create({ clinic: clinicId, code: `S${Date.now()}`, name: 'Consulta', category: 'servicio', salePrice: 50 });
}

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('createAppointment rechaza fecha de ayer y hora pasada de HOY; acepta hora futura y mañana', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const svc = await seedService(clinicId);
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });

  const body = (date, startTime) => ({ patient: patient._id, date, startTime, services: [{ product: svc._id }] });

  const past = await H.runController(appt.createAppointment, H.mockReq(clinicId, userId, body(YESTERDAY, '09:00')));
  assert.equal(past.statusCode, 400, JSON.stringify(past.payload));
  assert.equal(past.payload.message, PAST_DATE_MESSAGE);

  // HOY en una hora que ya pasó → rechazo (omitido en los primeros 90 min del día).
  const pastTime = timeToday(-90);
  if (pastTime) {
    const r = await H.runController(appt.createAppointment, H.mockReq(clinicId, userId, body(TODAY, pastTime)));
    assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
    assert.equal(r.payload.message, PAST_TIME_MESSAGE);
  }

  // HOY en una hora futura → permitido (omitido en los últimos minutos del día).
  const futureTime = timeToday(+30);
  if (futureTime) {
    const okToday = await H.runController(appt.createAppointment, H.mockReq(clinicId, userId, body(TODAY, futureTime)));
    assert.equal(okToday.statusCode, 201, JSON.stringify(okToday.payload));
  }

  const okTomorrow = await H.runController(appt.createAppointment, H.mockReq(clinicId, userId, body(TOMORROW, '09:00')));
  assert.equal(okTomorrow.statusCode, 201, JSON.stringify(okTomorrow.payload));
});

// ─────────────────────────────────────────────────────────────────────────────
test('updateAppointment bloquea reagendar al pasado (día u hora) pero permite editar cita ya pasada sin moverla', async () => {
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

  // Reagendar a HOY en una hora que ya pasó → rechazo.
  const pastTime = timeToday(-90);
  if (pastTime) {
    const reschedPastTime = await H.runController(
      appt.updateAppointment,
      H.mockReq(clinicId, userId, { date: TODAY, startTime: pastTime }, { params: { id: String(existing._id) }, role: 'admin' }),
    );
    assert.equal(reschedPastTime.statusCode, 400, JSON.stringify(reschedPastTime.payload));
    assert.equal(reschedPastTime.payload.message, PAST_TIME_MESSAGE);
  }

  // Editar (mismo día pasado, cambia la razón) → permitido: no se mueve el horario.
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
test('PUT /appointments/:id?clinic= reagenda una cita de OTRA sucursal solo con acceso', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otherClinic = new H.mongoose.Types.ObjectId(); // sucursal B (basta el id)
  const svc = await seedService(clinicId);
  const patient = await Patient.create({ clinic: otherClinic, firstName: 'Suc', lastName: 'B' });
  const cita = await Appointment.create({
    clinic: otherClinic, patient: patient._id, date: new Date(`${TOMORROW}T12:00:00`),
    startTime: '10:00', services: [{ product: svc._id, name: 'Consulta' }], status: 'pendiente', createdBy: userId,
  });
  const inTwoDays = ymd(new Date(Date.now() + 2 * 86400000));

  // Sin acceso a la sucursal B: el scope se queda en la activa → 404.
  const denied = await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { date: inTwoDays, startTime: '11:00' }, {
      params: { id: String(cita._id) }, query: { clinic: String(otherClinic) }, role: 'admin',
    }),
  );
  assert.equal(denied.statusCode, 404, JSON.stringify(denied.payload));

  // Con acceso a la sucursal B (reagendar desde el chat global) → 200.
  const req = H.mockReq(clinicId, userId, { date: inTwoDays, startTime: '11:00' }, {
    params: { id: String(cita._id) }, query: { clinic: String(otherClinic) }, role: 'admin',
  });
  req.user.clinics = [{ clinic: otherClinic, role: 'cajero' }];
  const ok = await H.runController(appt.updateAppointment, req);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));
  const after = await Appointment.findById(cita._id);
  assert.equal(after.startTime, '11:00');
  assert.equal((after.rescheduleHistory || []).length, 1, 'el reagendamiento debe quedar en el historial');
});

// ─────────────────────────────────────────────────────────────────────────────
test('createAppointmentFromChat rechaza fecha pasada y hora pasada de HOY', async () => {
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

  const pastTime = timeToday(-90);
  if (pastTime) {
    const r = await H.runController(
      chat.createAppointmentFromChat,
      H.mockReq(clinicId, userId, { date: TODAY, startTime: pastTime, services: [{ product: svc._id }] }, { params: { id: String(conv._id) } }),
    );
    assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
    assert.match(r.payload.message, /ya pasó/);
  }

  const ok = await H.runController(
    chat.createAppointmentFromChat,
    H.mockReq(clinicId, userId, { date: TOMORROW, startTime: '09:00', services: [{ product: svc._id }] }, { params: { id: String(conv._id) } }),
  );
  assert.equal(ok.statusCode, 201, JSON.stringify(ok.payload));
});
