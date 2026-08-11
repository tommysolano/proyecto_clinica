/**
 * Reasignación del doctor de una cita.
 *
 * Regla: se puede cambiar el doctor mientras la consulta NO se haya atendido
 * (agendada, confirmada, paciente en sala, consulta en curso). Una vez atendida
 * —status 'completada' o consultationEndedAt— el doctor queda fijo: la consulta
 * y su comisión (congelada en la venta) ya son suyas.
 *
 * Cubre las tres vías que tocan el doctor: PUT /appointments/:id,
 * POST /:id/assign-doctor y POST /:id/attended con doctorId.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const appt = require('../controllers/appointmentController');
const Product = require('../models/Product');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const User = require('../models/User');

const TOMORROW = new Date(Date.now() + 86400000);
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function seedCase() {
  const { clinicId, userId } = await H.seedClinic();
  const svc = await Product.create({
    clinic: clinicId, code: `S${Date.now()}`, name: 'Consulta', category: 'servicio', salePrice: 50,
  });
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });
  const mk = (name) =>
    User.create({ clinic: clinicId, name, email: `${name}${Date.now()}@t.com`, password: 'secret123', role: 'doctor' });
  const docA = await mk('DocA');
  const docB = await mk('DocB');
  const make = (extra = {}) =>
    Appointment.create({
      clinic: clinicId, patient: patient._id, doctor: docA._id,
      date: new Date(`${ymd(TOMORROW)}T12:00:00`), startTime: '10:00',
      services: [{ product: svc._id, name: 'Consulta' }],
      status: 'pendiente', createdBy: userId, ...extra,
    });
  return { clinicId, userId, docA, docB, make };
}

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('se puede reasignar el doctor mientras la cita no se haya atendido', async () => {
  const { clinicId, userId, docB, make } = await seedCase();

  for (const status of ['pendiente', 'confirmada', 'asistida']) {
    const apt = await make({ status });
    const r = await H.runController(
      appt.updateAppointment,
      H.mockReq(clinicId, userId, { doctor: String(docB._id) }, { params: { id: String(apt._id) } }),
    );
    assert.equal(r.statusCode, 200, `${status}: ${JSON.stringify(r.payload)}`);
    assert.equal(String(r.payload.doctor._id), String(docB._id), status);
  }

  // Incluso con la consulta ya iniciada (pero no cerrada) sigue siendo posible.
  const enCurso = await make({ status: 'asistida', consultationStartedAt: new Date() });
  const r = await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { doctor: String(docB._id) }, { params: { id: String(enCurso._id) } }),
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
});

// ─────────────────────────────────────────────────────────────────────────────
test('la reasignación deja auditoría: quién la hizo y cuándo', async () => {
  const { clinicId, userId, docA, docB, make } = await seedCase();
  const apt = await make();
  assert.equal(apt.doctorAssignedAt, undefined);

  await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { doctor: String(docB._id) }, { params: { id: String(apt._id) } }),
  );
  const saved = await Appointment.findById(apt._id);
  assert.equal(String(saved.doctor), String(docB._id));
  assert.ok(saved.doctorAssignedAt instanceof Date, 'debe registrar la fecha de reasignación');
  assert.equal(String(saved.doctorAssignedBy), String(userId));

  // Reenviar el MISMO doctor no es una reasignación: no toca la auditoría.
  const at = saved.doctorAssignedAt;
  await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { doctor: String(docB._id), reason: 'x' }, { params: { id: String(apt._id) } }),
  );
  const again = await Appointment.findById(apt._id);
  assert.equal(+again.doctorAssignedAt, +at, 'no debe re-sellar si el doctor no cambió');
  assert.notEqual(String(again.doctor), String(docA._id));
});

// ─────────────────────────────────────────────────────────────────────────────
test('una consulta ya atendida no cambia de doctor por ninguna de las tres vías', async () => {
  const { clinicId, userId, docA, docB, make } = await seedCase();
  const params = (id) => ({ params: { id: String(id) } });

  for (const done of [{ status: 'completada' }, { status: 'asistida', consultationEndedAt: new Date() }]) {
    const apt = await make(done);

    const put = await H.runController(
      appt.updateAppointment,
      H.mockReq(clinicId, userId, { doctor: String(docB._id) }, params(apt._id)),
    );
    assert.equal(put.statusCode, 400, JSON.stringify(put.payload));
    assert.match(put.payload.message, /ya fue atendida/i);

    const assign = await H.runController(
      appt.assignDoctor,
      H.mockReq(clinicId, userId, { doctorId: String(docB._id) }, params(apt._id)),
    );
    assert.equal(assign.statusCode, 400, JSON.stringify(assign.payload));

    const attended = await H.runController(
      appt.markAttended,
      H.mockReq(clinicId, userId, { doctorId: String(docB._id) }, params(apt._id)),
    );
    assert.equal(attended.statusCode, 400, JSON.stringify(attended.payload));

    const saved = await Appointment.findById(apt._id);
    assert.equal(String(saved.doctor), String(docA._id), 'el doctor original se conserva');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
test('asignar por primera vez sí funciona aunque la cita ya esté completada', async () => {
  // Caso real: enfermería cierra la cita sin doctor y luego se registra quién la vio.
  const { clinicId, userId, docB, make } = await seedCase();
  const apt = await make({ doctor: null, status: 'completada' });

  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctorId: String(docB._id) }, { params: { id: String(apt._id) } }),
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(String(r.payload.doctor._id), String(docB._id));
});
