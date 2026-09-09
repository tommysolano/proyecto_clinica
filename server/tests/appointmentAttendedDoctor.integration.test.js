/**
 * CORREGIR QUIÉN ATENDIÓ, en una cita que ya está completada.
 *
 * La cita que motivó esto se cerró «solo enfermería»: recepción asignó a la
 * enfermera, la cita se completó, y el doctor que de verdad vio al paciente
 * quedó fuera para siempre — la agenda, los reportes y las comisiones decían
 * que nadie lo atendió. La corrección vive en la misma puerta que el servicio y
 * el valor (`PATCH /:id/service-value`), que es donde mostrador ya arregla las
 * citas cerradas, con TRES reglas:
 *
 *   · solo admin/cajero (lo da la ruta) y solo con la cita YA terminada: una
 *     cita en curso se corrige por «Asignar atención», que es quien manda la
 *     cola;
 *   · se REESCRIBE el turno completado del doctor (o se añade si nunca hubo):
 *     la cita cerrada no puede volver a tener turnos pendientes;
 *   · el enfermero y lo que hizo cada turno no se tocan.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const appt = require('../controllers/appointmentController');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const User = require('../models/User');

const HOY = new Date();
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function seedCase() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Frank', lastName: 'J' });
  const docA = await User.create({
    clinic: clinicId, name: 'DocA', email: `doca${Date.now()}@t.com`, password: 'secret123', role: 'doctor',
  });
  const docB = await User.create({
    clinic: clinicId, name: 'DocB', email: `docb${Date.now()}@t.com`, password: 'secret123', role: 'doctor',
  });
  const enfermera = await User.create({
    clinic: clinicId, name: 'EnfA', email: `enf${Date.now()}@t.com`, password: 'secret123', role: 'enfermero',
  });
  const make = (extra = {}) =>
    Appointment.create({
      clinic: clinicId,
      patient: patient._id,
      date: new Date(`${ymd(HOY)}T12:00:00`),
      startTime: '11:30',
      status: 'completada',
      consultationEndedAt: new Date(),
      createdBy: userId,
      ...extra,
    });
  return { clinicId, userId, patient, docA, docB, enfermera, make };
}

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('la cita cerrada «solo enfermería» recibe al doctor que la atendió', async () => {
  const { clinicId, userId, docA, enfermera, make } = await seedCase();
  // El caso Frank: se asignó y completó solo el turno de enfermería.
  const apt = await make({
    attendedByNurse: enfermera._id,
    turns: [
      { kind: 'enfermeria', user: enfermera._id, order: 0, status: 'completado', completedAt: new Date() },
    ],
  });

  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(clinicId, userId, { attendedDoctor: String(docA._id) },
      { role: 'cajero', params: { id: String(apt._id) } })
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(apt._id);
  assert.equal(String(enBase.doctor), String(docA._id), 'el espejo dice quién atendió');
  assert.equal(enBase.status, 'completada', 'corregir no reabre la cita');
  assert.equal(enBase.turns.length, 2, 'enfermería + el doctor añadido');
  const turnoDoctor = enBase.turns.find((t) => t.kind === 'doctor');
  assert.equal(turnoDoctor.status, 'completado', 'el turno entra YA cerrado: no vuelve a la agenda');
  assert.equal(String(turnoDoctor.user), String(docA._id));
  const turnoEnf = enBase.turns.find((t) => t.kind === 'enfermeria');
  assert.equal(String(turnoEnf.user), String(enfermera._id), 'la enfermera no se toca');
});

test('cambiar quién atendió REESCRIBE el turno del doctor, no apila otro', async () => {
  const { clinicId, userId, docA, docB, make } = await seedCase();
  const apt = await make({
    doctor: docA._id,
    turns: [
      { kind: 'doctor', user: docA._id, order: 0, status: 'completado', completedAt: new Date() },
    ],
  });

  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(clinicId, userId, { attendedDoctor: String(docB._id) },
      { role: 'admin', params: { id: String(apt._id) } })
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(apt._id);
  const turnosDoctor = enBase.turns.filter((t) => t.kind === 'doctor');
  assert.equal(turnosDoctor.length, 1, 'un solo turno de doctor, corregido');
  assert.equal(String(turnosDoctor[0].user), String(docB._id));
  assert.equal(String(enBase.doctor), String(docB._id));
  assert.ok(turnosDoctor[0].assignedBy, 'queda la huella de quién corrigió');
});

test('una cita que sigue en curso no se corrige por aquí', async () => {
  const { clinicId, userId, docA, make } = await seedCase();
  const apt = await make({ status: 'asistida', consultationEndedAt: null, doctor: docA._id });

  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(clinicId, userId, { attendedDoctor: String(docA._id) },
      { role: 'cajero', params: { id: String(apt._id) } })
  );
  assert.equal(r.statusCode, 400, 'para eso está «Asignar atención»');
});

test('con un doctor todavía pendiente en la cola, tampoco', async () => {
  const { clinicId, userId, docA, docB, make } = await seedCase();
  const apt = await make({
    status: 'completada',
    consultationEndedAt: new Date(),
    doctor: docA._id,
    turns: [
      { kind: 'doctor', user: docA._id, order: 0, status: 'completado', completedAt: new Date() },
      { kind: 'doctor', user: docB._id, order: 1, status: 'pendiente' },
    ],
  });

  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(clinicId, userId, { attendedDoctor: String(docB._id) },
      { role: 'cajero', params: { id: String(apt._id) } })
  );
  assert.equal(r.statusCode, 400, 'la cola pendiente se corrige por «Asignar atención»');

  const enBase = await Appointment.findById(apt._id);
  assert.equal(
    enBase.turns.filter((t) => t.kind === 'doctor').length,
    2,
    'no se tocó ningún turno'
  );
});

test('el doctor tiene que atender en la sucursal de la cita', async () => {
  const { clinicId, userId, make } = await seedCase();
  const otro = await H.seedClinic();
  const deOtraSede = await User.create({
    clinics: [{ clinic: otro.clinicId, role: 'doctor' }],
    name: 'DocC', email: `docc${Date.now()}@t.com`, password: 'secret123', role: 'doctor',
  });
  const apt = await make();

  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(clinicId, userId, { attendedDoctor: String(deOtraSede._id) },
      { role: 'cajero', params: { id: String(apt._id) } })
  );
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
});

test('sin nombre no hay corrección que valga', async () => {
  const { clinicId, userId, make } = await seedCase();
  const apt = await make();

  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(clinicId, userId, { attendedDoctor: '' },
      { role: 'cajero', params: { id: String(apt._id) } })
  );
  assert.equal(r.statusCode, 400);
});

test('mandar lo mismo que ya había no cuenta como cambio', async () => {
  const { clinicId, userId, docA, make } = await seedCase();
  const apt = await make({
    doctor: docA._id,
    turns: [
      { kind: 'doctor', user: docA._id, order: 0, status: 'completado', completedAt: new Date() },
    ],
  });

  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(clinicId, userId, { attendedDoctor: String(docA._id) },
      { role: 'cajero', params: { id: String(apt._id) } })
  );
  assert.equal(r.statusCode, 400, 'no hay nada que cambiar');

  const enBase = await Appointment.findById(apt._id);
  assert.equal(String(enBase.doctor), String(docA._id));
  assert.equal(enBase.turns[0].assignedBy, undefined, 'ni huella de una corrección que no fue');
});
