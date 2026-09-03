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
const Clinic = require('../models/Clinic');
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

test('caja agenda en otra sucursal y se respetan los espacios de la sucursal destino', async () => {
  const activeClinic = await Clinic.create({ name: 'Sucursal activa' });
  const targetClinic = await Clinic.create({
    name: 'Sucursal destino',
    appointmentSlotMinutes: 30,
  });
  const userId = new H.mongoose.Types.ObjectId();
  const patient = await Patient.create({
    clinic: activeClinic._id,
    firstName: 'Ana',
    lastName: 'P',
  });
  const body = (startTime) => ({
    patient: patient._id,
    clinic: targetClinic._id,
    date: TOMORROW,
    startTime,
    agreedValue: 42,
    isCanje: false,
  });
  const cashierRequest = (startTime) => {
    const req = H.mockReq(activeClinic._id, userId, body(startTime), { role: 'cajero' });
    // El cajero trabaja en una sola sede, pero agenda para toda la organización.
    req.user.clinics = [{ clinic: activeClinic._id, role: 'cajero' }];
    return req;
  };

  const invalidSlot = await H.runController(
    appt.createAppointment,
    cashierRequest('09:15')
  );
  assert.equal(invalidSlot.statusCode, 400, JSON.stringify(invalidSlot.payload));
  assert.equal(invalidSlot.payload.code, 'SLOT_INVALID');

  const created = await H.runController(
    appt.createAppointment,
    cashierRequest('09:30')
  );
  assert.equal(created.statusCode, 201, JSON.stringify(created.payload));
  const stored = await Appointment.findById(created.payload._id);
  assert.equal(String(stored.clinic), String(targetClinic._id));
  assert.equal(stored.agreedValue, 42);

  const callCenterReq = H.mockReq(activeClinic._id, userId, body('10:00'), {
    role: 'call_center',
  });
  callCenterReq.user.clinics = [{ clinic: activeClinic._id, role: 'call_center' }];
  const denied = await H.runController(appt.createAppointment, callCenterReq);
  assert.equal(denied.statusCode, 403, JSON.stringify(denied.payload));
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
/**
 * El ALCANCE lo pone el ROL, no el `?clinic=` de la petición (ver
 * `filtroSucursalCita`): mostrador y administración reagendan cualquier cita de
 * la organización —es lo mismo que ya veían en la agenda— y el resto de roles
 * solo las de las sucursales que tienen asignadas. Antes la lectura y la
 * escritura no coincidían, y de ahí salía un 404 sobre una cita que estaba a la
 * vista.
 */
test('PUT /appointments/:id reagenda una cita de OTRA sucursal según el rol', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const otherClinic = new H.mongoose.Types.ObjectId(); // sucursal B (basta el id)
  const svc = await seedService(clinicId);
  const patient = await Patient.create({ clinic: otherClinic, firstName: 'Suc', lastName: 'B' });
  const cita = await Appointment.create({
    clinic: otherClinic, patient: patient._id, date: new Date(`${TOMORROW}T12:00:00`),
    startTime: '10:00', services: [{ product: svc._id, name: 'Consulta' }], status: 'pendiente', createdBy: userId,
  });
  const inTwoDays = ymd(new Date(Date.now() + 2 * 86400000));

  // Quien atiende solo llega a sus sucursales: la de la sucursal B no es suya.
  const doctorReq = H.mockReq(clinicId, userId, { date: inTwoDays, startTime: '11:00' }, {
    params: { id: String(cita._id) }, role: 'doctor',
  });
  doctorReq.user.clinics = [{ clinic: clinicId, role: 'doctor' }];
  const denied = await H.runController(appt.updateAppointment, doctorReq);
  assert.equal(denied.statusCode, 404, JSON.stringify(denied.payload));

  // Administración: la organización entera, sin tener que pasar `?clinic=`.
  const req = H.mockReq(clinicId, userId, { date: inTwoDays, startTime: '11:00' }, {
    params: { id: String(cita._id) }, role: 'admin',
  });
  req.user.clinics = [{ clinic: clinicId, role: 'admin' }];
  const ok = await H.runController(appt.updateAppointment, req);
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));
  const after = await Appointment.findById(cita._id);
  assert.equal(after.startTime, '11:00');
  assert.equal(String(after.clinic), String(otherClinic), 'reagendar NO cambia la cita de sucursal');
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
