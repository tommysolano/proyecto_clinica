/**
 * REPRODUCCIÓN: asignar DOS DOCTORES en la misma cita y que se borre el segundo.
 *
 * Reporte de mostrador: «asigno a la doctora Rosi y luego a la doctora Ester;
 * guardo; al revisar la cita solo aparece Rosi». Se prueba el camino completo
 * del servidor con las dos variantes que hace recepción:
 *   · los dos en la MISMA asignación (una sola cola, dos pasos);
 *   · primero Rosi, guardar, reabrir y añadir a Ester (dos asignaciones);
 * y lo mismo con DOS ENFERMERAS (¿se borran también?).
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
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });
  const crear = (name, role) =>
    User.create({
      clinics: [{ clinic: clinicId, role }],
      name, email: `${name}${Date.now()}${Math.random()}@t.com`, password: 'secret123', role,
    });
  const rosi = await crear('Rosi', 'doctor');
  const ester = await crear('Ester', 'doctor');
  const enf1 = await crear('Enf1', 'enfermero');
  const enf2 = await crear('Enf2', 'enfermero');
  const make = (extra = {}) =>
    Appointment.create({
      clinic: clinicId,
      patient: patient._id,
      date: new Date(`${ymd(HOY)}T12:00:00`),
      startTime: '10:00',
      status: 'pendiente',
      createdBy: userId,
      ...extra,
    });
  return { clinicId, userId, rosi, ester, enf1, enf2, make };
}

const asignar = (appt_, userId, steps, role = 'cajero') =>
  H.runController(
    appt.assignDoctor,
    H.mockReq(undefined, userId, { steps }, { role, params: { id: String(appt_._id) } })
  );

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('DOS DOCTORES en una sola asignación: los dos turnos quedan', async () => {
  const { userId, rosi, ester, make } = await seedCase();
  const apt = await make();

  const r = await asignar(apt, userId, [
    { kind: 'doctor', user: String(rosi._id) },
    { kind: 'doctor', user: String(ester._id) },
  ]);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(apt._id).lean();
  const turnosDoctor = (enBase.turns || []).filter((t) => t.kind === 'doctor');
  assert.equal(turnosDoctor.length, 2, `turnos de doctor: ${JSON.stringify(enBase.turns)}`);
  assert.deepEqual(
    turnosDoctor.map((t) => String(t.user)),
    [String(rosi._id), String(ester._id)],
    'en el orden en que se asignaron'
  );
});

test('DOS DOCTORES en dos tandas (Rosi, guardar; reabrir y añadir Ester): quedan los dos', async () => {
  const { userId, rosi, ester, make } = await seedCase();
  const apt = await make();

  let r = await asignar(apt, userId, [{ kind: 'doctor', user: String(rosi._id) }]);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  // Reasignación con la cola precargada: Rosi sigue pendiente y se añade Ester.
  r = await asignar(apt, userId, [
    { kind: 'doctor', user: String(rosi._id) },
    { kind: 'doctor', user: String(ester._id) },
  ]);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(apt._id).lean();
  const turnosDoctor = (enBase.turns || []).filter((t) => t.kind === 'doctor');
  assert.equal(turnosDoctor.length, 2, `turnos de doctor: ${JSON.stringify(enBase.turns)}`);
});

test('DOS ENFERMERAS en la misma cola: los dos turnos quedan', async () => {
  const { userId, enf1, enf2, make } = await seedCase();
  const apt = await make();

  const r = await asignar(apt, userId, [
    { kind: 'enfermeria', user: String(enf1._id) },
    { kind: 'enfermeria', user: String(enf2._id) },
  ]);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(apt._id).lean();
  const turnosEnf = (enBase.turns || []).filter((t) => t.kind === 'enfermeria');
  assert.equal(turnosEnf.length, 2, `turnos de enfermería: ${JSON.stringify(enBase.turns)}`);
  assert.deepEqual(
    turnosEnf.map((t) => String(t.user)),
    [String(enf1._id), String(enf2._id)]
  );
});

test('DOCTOR + DOCTOR cuando el primero YA completó: se conserva el cerrado y entra el segundo', async () => {
  const { userId, rosi, ester, make } = await seedCase();
  const apt = await make({
    status: 'asistida',
    turns: [
      { kind: 'doctor', user: rosi._id, order: 0, status: 'completado', completedAt: new Date() },
    ],
  });

  // La cola que la pantalla mandaría al reabrir (Rosi ya no es pendiente).
  const r = await asignar(apt, userId, [{ kind: 'doctor', user: String(ester._id) }]);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(apt._id).lean();
  const turnosDoctor = (enBase.turns || []).filter((t) => t.kind === 'doctor');
  assert.equal(turnosDoctor.length, 2, `Rosi completado + Ester pendiente: ${JSON.stringify(enBase.turns)}`);
  assert.equal(
    (enBase.turns || []).filter((t) => t.kind === 'doctor' && t.status === 'completado').length,
    1
  );
});
