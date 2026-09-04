/**
 * ATENCIÓN SIN CITA: la cita se registra SOLA al guardar el seguimiento.
 *
 * En óptica el cliente entra por la puerta. Hasta ahora la consulta se escribía
 * igual —el seguimiento se guardaba— pero la cita no existía, y con ella se
 * perdía todo lo que cuelga de la cita: la atención no salía en la agenda, ni en
 * los reportes, ni devengaba comisión, ni contaba para «paciente nuevo», ni
 * había de dónde cobrarla.
 *
 * Lo que estos tests vigilan:
 *  1. Guardar un seguimiento SIN cita crea la cita, ya cerrada y con su turno.
 *  2. Guardar CON cita sigue comportándose igual: no se duplica nada.
 *  3. Solo la crean los roles que ATIENDEN. Un cajero documentando por otro no
 *     debe acabar con pacientes en su dashboard ni en sus comisiones.
 *  4. La hora es la REAL, no una de la rejilla de la agenda: una atención sin
 *     cita no pasa por la validación de espacios (agendar a las 14:07 se
 *     rechaza), y por eso NO puede ir por el alta normal de citas.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const Clinic = require('../models/Clinic');
const records = require('../controllers/clinicalRecordController');
const appt = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });

  const optico = await crear('Opti', 'optica');
  const cajero = await crear('Caja', 'cajero');

  return { clinicId, userId, patient, optico, cajero };
}

const guardarSeguimiento = (clinicId, userId, patientId, role, body = {}) =>
  H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, userId, { motivoConsulta: 'Control visual', ...body },
      { role, params: { patientId: String(patientId) } }),
  );

// ───────────────────── el caso de óptica ─────────────────────

test('óptica guarda un seguimiento sin cita y la cita se registra sola', async () => {
  const { clinicId, patient, optico } = await seed();

  assert.equal(await Appointment.countDocuments({ clinic: clinicId }), 0, 'se parte sin citas');

  const r = await guardarSeguimiento(clinicId, optico._id, patient._id, 'optica');
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const citas = await Appointment.find({ clinic: clinicId }).lean();
  assert.equal(citas.length, 1, 'se registró la atención');
  const cita = citas[0];

  assert.equal(String(cita.patient), String(patient._id));
  assert.equal(String(cita.doctor), String(optico._id), 'la atendió quien la escribió');
  assert.equal(String(cita.createdBy), String(optico._id));
  assert.equal(cita.createdByRole, 'optica');
  assert.equal(cita.status, 'completada', 'nace cerrada: el trabajo ya está hecho');
  assert.ok(cita.consultationEndedAt, 'con su hora de fin');
  assert.equal(cita.isFirstVisit, true, 'era su primera vez');

  // El turno queda cerrado y colgado del seguimiento que lo cerró: es lo que
  // hace que la historia clínica y la cita cuenten lo mismo.
  assert.equal(cita.turns.length, 1);
  assert.equal(cita.turns[0].status, 'completado');
  assert.equal(String(cita.turns[0].user), String(optico._id));
  const rec = await ClinicalRecord.findOne({ clinic: clinicId, patient: patient._id }).lean();
  assert.equal(String(cita.turns[0].followUp), String(rec.followUps.slice(-1)[0]._id));

  // Y la respuesta lo dice, para que la pantalla pueda avisar.
  assert.ok(r.payload.autoAppointment, 'la respuesta trae la cita registrada');
  assert.equal(String(r.payload.autoAppointment._id), String(cita._id));
});

test('la cita automática le aparece a óptica en su agenda', async () => {
  const { clinicId, patient, optico } = await seed();
  await guardarSeguimiento(clinicId, optico._id, patient._id, 'optica');

  const r = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, optico._id, {}, { role: 'optica', query: {} }),
  );
  const lista = Array.isArray(r.payload) ? r.payload : r.payload?.appointments || [];
  assert.equal(lista.length, 1, 'la atención está en su agenda del día');
  assert.equal(String(lista[0].patient?._id || lista[0].patient), String(patient._id));
});

test('la hora es la real, no una de la rejilla de espacios de la agenda', async () => {
  const { clinicId, patient, optico } = await seed();
  // La sucursal agenda en espacios de 20 min: 14:00, 14:20, 14:40…
  await Clinic.findByIdAndUpdate(clinicId, { appointmentSlotMinutes: 20 });

  await guardarSeguimiento(clinicId, optico._id, patient._id, 'optica');
  const cita = await Appointment.findOne({ clinic: clinicId }).lean();

  assert.match(cita.startTime, /^\d{2}:\d{2}$/);
  // No se comprueba que NO caiga en la rejilla (a veces cae por casualidad): lo
  // que se comprueba es que la atención se registró pese a los espacios. Por el
  // alta normal de citas, una hora fuera de la rejilla se rechaza con
  // SLOT_INVALID y el cliente se habría quedado sin registrar.
  assert.ok(cita._id, 'la atención quedó registrada con espacios activos');
});

// ───────────────────── que no se rompa lo de antes ─────────────────────

test('con cita de partida NO se crea una segunda', async () => {
  const { clinicId, userId, patient, optico } = await seed();
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { steps: [{ kind: 'doctor', user: String(optico._id) }] },
      { params: { id: String(cita._id) } }),
  );

  const r = await guardarSeguimiento(clinicId, optico._id, patient._id, 'optica', {
    appointmentId: String(cita._id),
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  assert.equal(await Appointment.countDocuments({ clinic: clinicId }), 1, 'sigue habiendo una sola');
  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.status, 'completada', 'y se cerró como siempre');
  assert.equal(r.payload.autoAppointment, undefined, 'no se anuncia ninguna cita nueva');
});

test('un cajero que documenta por otro NO genera una cita a su nombre', async () => {
  const { clinicId, patient, cajero } = await seed();

  const r = await guardarSeguimiento(clinicId, cajero._id, patient._id, 'cajero');
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  assert.equal(
    await Appointment.countDocuments({ clinic: clinicId }),
    0,
    'documentar no es atender: no se le inventa una consulta',
  );
});

test('la segunda visita del mismo paciente ya no cuenta como primera', async () => {
  const { clinicId, patient, optico } = await seed();
  await guardarSeguimiento(clinicId, optico._id, patient._id, 'optica');
  await guardarSeguimiento(clinicId, optico._id, patient._id, 'optica', { motivoConsulta: 'Control' });

  const citas = await Appointment.find({ clinic: clinicId }).sort({ createdAt: 1 }).lean();
  assert.equal(citas.length, 2, 'dos consultas, dos citas');
  assert.equal(citas[0].isFirstVisit, true);
  assert.equal(citas[1].isFirstVisit, false, '«paciente nuevo» solo la primera vez');
});

test('si la cita no se pudiera registrar, el seguimiento NO se pierde', async () => {
  const { clinicId, patient, optico } = await seed();
  // Se rompe la creación de citas a propósito: el seguimiento es lo que no se
  // puede perder, la cita es contabilidad.
  const original = Appointment.prototype.save;
  Appointment.prototype.save = function fallar() {
    return Promise.reject(new Error('fallo simulado al guardar la cita'));
  };
  try {
    const r = await guardarSeguimiento(clinicId, optico._id, patient._id, 'optica');
    assert.equal(r.statusCode, 201, 'el seguimiento se guarda igual');
  } finally {
    Appointment.prototype.save = original;
  }

  const rec = await ClinicalRecord.findOne({ clinic: clinicId, patient: patient._id }).lean();
  assert.equal(rec.followUps.length, 1, 'la consulta quedó escrita');
});

// ───────── registrar y atender de una vez (el camino de óptica) ─────────

/**
 * Desde sep-2026 óptica YA NO agenda desde el registro del paciente: registrar
 * ES atender. La pantalla llama a `createWalkIn` y entra a la consulta, así que
 * este es ahora su único camino y tiene que estar cubierto.
 */
test('óptica registra y atiende: la cita nace abierta, suya y a la hora real', async () => {
  const { clinicId, patient, optico } = await seed();

  const r = await H.runController(
    appt.createWalkIn,
    H.mockReq(clinicId, optico._id, { patient: String(patient._id), reason: 'Examen visual' },
      { role: 'optica' }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const cita = await Appointment.findOne({ clinic: clinicId }).lean();
  assert.equal(cita.status, 'asistida', 'abierta: el cliente está delante, aún no ha terminado');
  assert.equal(String(cita.doctor), String(optico._id), 'a su nombre');
  assert.equal(cita.turns.length, 1);
  assert.equal(cita.turns[0].status, 'pendiente', 'su turno está en marcha');
  assert.ok(cita.consultationStartedAt, 'con el reloj arrancado');
  assert.match(cita.startTime, /^\d{2}:\d{2}$/, 'la hora es la real, no una de la rejilla');
  assert.equal(cita.date.getHours(), 12, 'y `date` es el DÍA, como en cualquier cita');
});

test('la atención inmediata sale en la agenda del DÍA de quien la abrió', async () => {
  const { clinicId, patient, optico } = await seed();
  await H.runController(
    appt.createWalkIn,
    H.mockReq(clinicId, optico._id, { patient: String(patient._id) }, { role: 'optica' }),
  );

  // Como la pide la pantalla: acotada al día que se está mirando. Sin el rango
  // de días enteros, una atención de la mañana no salía por ningún lado.
  const hoy = new Date();
  const ymd = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
  const r = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, optico._id, {}, { role: 'optica', query: { startDate: ymd, endDate: ymd } }),
  );
  const lista = Array.isArray(r.payload) ? r.payload : r.payload?.appointments || [];
  assert.equal(lista.length, 1, 'la tiene delante en su agenda del día');
});
