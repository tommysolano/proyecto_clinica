/**
 * TURNOS DE ATENCIÓN: varios doctores por cita, y enfermería.
 *
 * Lo que estos tests vigilan, que se rompe en silencio:
 *  1. `appointment.doctor` es un ESPEJO del turno vigente. Lo leen unos treinta
 *     sitios (agenda, dashboards, comisiones, reportes). Si deja de seguir a los
 *     turnos, un doctor abre su agenda y su paciente no está.
 *  2. Asignar pone la cita en 'asistida'. Se quitó el paso de "marcar asistida",
 *     pero el estado NO era cosmético: `autoNoShow` marca como ausente toda cita
 *     que siga 'pendiente' un minuto después de su hora. Sin esto, cada paciente
 *     que entra por la puerta acabaría registrado como que no vino.
 *  3. El seguimiento del primer doctor NO cierra la cita: la pasa al siguiente.
 *  4. Dos enfermeros no pueden atender al mismo paciente: el reclamo es atómico.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const appt = require('../controllers/appointmentController');
const clinicalRecords = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const crearUsuario = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });

  const docA = await crearUsuario('DocA', 'doctor');
  const docB = await crearUsuario('DocB', 'ginecologia');
  const enf1 = await crearUsuario('Enf1', 'enfermero');
  const enf2 = await crearUsuario('Enf2', 'enfermero');

  const cita = await Appointment.create({
    clinic: clinicId,
    patient: patient._id,
    date: H.docDate(),
    startTime: '10:00',
    status: 'pendiente',
  });

  return { clinicId, userId, patient, docA, docB, enf1, enf2, cita };
}

const params = (id) => ({ params: { id: String(id) } });

// ───────────────────── asignar ─────────────────────

test('asignar dos doctores deja el espejo en el PRIMERO y la cita en asistida', async () => {
  const { clinicId, userId, docA, docB, cita } = await seed();

  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: [String(docA._id), String(docB._id)] }, params(cita._id)),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.turns.length, 2);
  assert.equal(String(guardada.turns[0].user), String(docA._id));
  assert.equal(String(guardada.turns[1].user), String(docB._id));
  assert.equal(String(guardada.doctor), String(docA._id), 'el espejo apunta al turno vigente');
  // Sin esto, autoNoShow marcaría ausente al paciente que está en la sala.
  assert.equal(guardada.status, 'asistida');
});

test('el seguimiento del primero NO cierra la cita: pasa al segundo', async () => {
  const { clinicId, userId, patient, docA, docB, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: [String(docA._id), String(docB._id)] }, params(cita._id)),
  );

  const r1 = await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, docA._id, { descripcion: 'Primera parte', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r1.statusCode < 400, true, JSON.stringify(r1.payload));

  let guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'asistida', 'sigue abierta: falta el segundo doctor');
  assert.equal(guardada.turns[0].status, 'completado');
  assert.ok(guardada.turns[0].followUp, 'el turno guarda SU seguimiento');
  assert.equal(String(guardada.doctor), String(docB._id), 'el espejo ya apunta al segundo');

  // El segundo cierra.
  const r2 = await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, docB._id, { descripcion: 'Segunda parte', appointmentId: String(cita._id) },
      { role: 'ginecologia', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r2.statusCode < 400, true, JSON.stringify(r2.payload));

  guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'completada');
  assert.ok(guardada.consultationEndedAt);

  // Y cada doctor escribió su propio seguimiento: no se pisan.
  const record = await ClinicalRecord.findOne({ patient: patient._id });
  assert.equal(record.followUps.length, 2);
  assert.deepEqual(record.followUps.map((f) => f.descripcion), ['Primera parte', 'Segunda parte']);
});

test('una cita sin turnos se sigue cerrando con un solo seguimiento', async () => {
  // Compatibilidad: las citas anteriores al cambio no tienen `turns`.
  const { clinicId, patient, docA, cita } = await seed();
  await Appointment.findByIdAndUpdate(cita._id, { doctor: docA._id, status: 'asistida' });

  await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, docA._id, { descripcion: 'Consulta', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'completada');
});

test('reasignar conserva el turno de quien ya atendió', async () => {
  const { clinicId, userId, patient, docA, docB, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: [String(docA._id)] }, params(cita._id)),
  );
  await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, docA._id, { descripcion: 'Ya atendida', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  // Ahora se añade un segundo doctor a la MISMA cita (ya completada por el 1º).
  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: [String(docA._id), String(docB._id)] }, params(cita._id)),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(cita._id);
  const completados = guardada.turns.filter((t) => t.status === 'completado');
  assert.equal(completados.length, 1, 'el turno del primero sigue ahí');
  assert.equal(String(completados[0].user), String(docA._id));
  assert.ok(completados[0].followUp, 'y conserva su seguimiento');
});

// ───────────────────── enfermería ─────────────────────

test('mandar a enfermería crea un turno SIN dueño', async () => {
  const { clinicId, userId, cita } = await seed();
  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { nursing: true }, params(cita._id)),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(cita._id);
  const turno = guardada.turns.find((t) => t.kind === 'enfermeria');
  assert.ok(turno, 'hay turno de enfermería');
  assert.equal(turno.user, null, 'sin dueño: sale a la bandeja de todos');
  assert.equal(guardada.status, 'asistida');
});

test('solo UN enfermero se queda la cita aunque dos la reclamen a la vez', async () => {
  const { clinicId, userId, enf1, enf2, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { nursing: true }, params(cita._id)),
  );

  // A la vez, como pasa de verdad cuando dos ven el aviso en el móvil.
  const [r1, r2] = await Promise.all([
    H.runController(appt.nurseClaim, H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', ...params(cita._id) })),
    H.runController(appt.nurseClaim, H.mockReq(clinicId, enf2._id, {}, { role: 'enfermero', ...params(cita._id) })),
  ]);

  const codigos = [r1.statusCode, r2.statusCode].sort();
  assert.deepEqual(codigos, [200, 409], 'uno se la queda y al otro se le dice que ya está tomada');

  const guardada = await Appointment.findById(cita._id);
  const duenos = [String(enf1._id), String(enf2._id)];
  assert.ok(duenos.includes(String(guardada.attendedByNurse)));
  const turno = guardada.turns.find((t) => t.kind === 'enfermeria');
  assert.equal(String(turno.user), String(guardada.attendedByNurse), 'el turno queda a nombre de quien la reclamó');
});

test('el seguimiento del enfermero cierra su turno y la cita', async () => {
  const { clinicId, userId, patient, enf1, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { nursing: true }, params(cita._id)),
  );
  await H.runController(
    appt.nurseClaim,
    H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', ...params(cita._id) }),
  );

  const r = await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, enf1._id, { descripcion: 'Suero aplicado', appointmentId: String(cita._id) },
      { role: 'enfermero', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'completada');
  assert.equal(guardada.turns.find((t) => t.kind === 'enfermeria').status, 'completado');
});

test('doctor y enfermería en la misma cita: primero el doctor, luego enfermería', async () => {
  const { clinicId, userId, patient, docA, enf1, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: [String(docA._id)], nursing: true }, params(cita._id)),
  );

  await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, docA._id, { descripcion: 'Consulta', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  let guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'asistida', 'falta enfermería: la cita sigue abierta');

  await H.runController(
    appt.nurseClaim,
    H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', ...params(cita._id) }),
  );
  await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, enf1._id, { descripcion: 'Suero', appointmentId: String(cita._id) },
      { role: 'enfermero', params: { patientId: String(patient._id) } }),
  );

  guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'completada');
  // El espejo se queda con el doctor que atendió, no en blanco por el turno de
  // enfermería: comisiones y reportes leen ese campo.
  assert.equal(String(guardada.doctor), String(docA._id));
});

// ───────────── la cola: a cada uno cuando le toca ─────────────
//
// Anunciar la cita a los tres doctores a la vez es peor que no avisar: tres
// consultorios esperando al mismo paciente. La cita solo existe para quien la
// tiene AHORA, y para quien ya la atendió (su historial no se le puede borrar).

test('al segundo doctor la cita NO le aparece hasta que el primero guarda', async () => {
  const { clinicId, userId, patient, docA, docB, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: [String(docA._id), String(docB._id)] }, params(cita._id)),
  );

  const agendaDe = async (doc, role) => {
    const r = await H.runController(
      appt.getAppointments,
      H.mockReq(clinicId, doc._id, {}, { role, query: {} }),
    );
    const lista = Array.isArray(r.payload) ? r.payload : r.payload?.appointments || [];
    return lista.map((a) => String(a._id));
  };

  assert.deepEqual(await agendaDe(docA, 'doctor'), [String(cita._id)], 'el primero la ve');
  assert.deepEqual(await agendaDe(docB, 'ginecologia'), [], 'el segundo todavía NO');

  // El primero termina su parte.
  await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, docA._id, { descripcion: 'Primera parte', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  assert.deepEqual(await agendaDe(docB, 'ginecologia'), [String(cita._id)], 'ahora sí le toca');
  // Y al primero no se le cae del historial por haber pasado el turno.
  assert.deepEqual(await agendaDe(docA, 'doctor'), [String(cita._id)], 'sigue en su historial');
});

test('enfermería detrás de un doctor no sale a la bandeja hasta que él termina', async () => {
  const { clinicId, userId, patient, docA, enf1, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: [String(docA._id)], nursing: true }, params(cita._id)),
  );

  const bandeja = async () => {
    const r = await H.runController(
      appt.getAppointments,
      H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', query: {} }),
    );
    const lista = Array.isArray(r.payload) ? r.payload : r.payload?.appointments || [];
    return lista.map((a) => String(a._id));
  };

  assert.deepEqual(await bandeja(), [], 'el paciente sigue con el doctor');

  await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, docA._id, { descripcion: 'Consulta', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  assert.deepEqual(await bandeja(), [String(cita._id)], 'ahora le toca a enfermería');
});

test('el enfermero que atendió conserva la cita aunque el turno pase a otro', async () => {
  const { clinicId, userId, patient, docA, enf1, cita } = await seed();
  // Enfermería primero (toma de signos) y el doctor después.
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: [String(docA._id)], nursing: true }, params(cita._id)),
  );
  // Se reordena para que enfermería vaya delante, como cuando se toman signos.
  const previa = await Appointment.findById(cita._id);
  previa.turns = [
    { ...previa.turns[1].toObject(), order: 0 },
    { ...previa.turns[0].toObject(), order: 1 },
  ];
  require('../utils/appointmentTurns').sincronizarEspejo(previa);
  await previa.save();

  await H.runController(appt.nurseClaim, H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', ...params(cita._id) }));
  await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, enf1._id, { descripcion: 'Signos vitales', appointmentId: String(cita._id) },
      { role: 'enfermero', params: { patientId: String(patient._id) } }),
  );

  const r = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', query: {} }),
  );
  const lista = Array.isArray(r.payload) ? r.payload : r.payload?.appointments || [];
  assert.deepEqual(lista.map((a) => String(a._id)), [String(cita._id)], 'la que atendió no se le borra');

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.currentTurnKind, 'doctor', 'la pelota pasó al doctor');
  assert.equal(guardada.status, 'asistida', 'sigue abierta: falta el doctor');
});

test('enfermería puede ir PRIMERO: la cola la ordena quien asigna', async () => {
  const { clinicId, userId, docA, enf1, cita } = await seed();

  // Signos vitales antes de que pase el médico: el caso más común, e imposible
  // mientras enfermería fue una casilla que siempre caía al final.
  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, {
      steps: [{ kind: 'enfermeria' }, { kind: 'doctor', user: String(docA._id) }],
    }, params(cita._id)),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(cita._id);
  assert.deepEqual(guardada.turns.map((t) => t.kind), ['enfermeria', 'doctor']);
  assert.equal(guardada.currentTurnKind, 'enfermeria', 'empieza enfermería');

  // Al doctor todavía no le toca.
  const agenda = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, docA._id, {}, { role: 'doctor', query: {} }),
  );
  const lista = Array.isArray(agenda.payload) ? agenda.payload : agenda.payload?.appointments || [];
  assert.deepEqual(lista.map((a) => String(a._id)), [], 'el doctor espera a que enfermería termine');

  // Y a los enfermeros sí.
  const bandeja = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', query: {} }),
  );
  const suyas = Array.isArray(bandeja.payload) ? bandeja.payload : bandeja.payload?.appointments || [];
  assert.deepEqual(suyas.map((a) => String(a._id)), [String(cita._id)]);
});

test('enfermería puede repetirse en la cola (signos antes, aplicación después)', async () => {
  const { clinicId, userId, docA, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, {
      steps: [
        { kind: 'enfermeria' },
        { kind: 'doctor', user: String(docA._id) },
        { kind: 'enfermeria' },
      ],
    }, params(cita._id)),
  );

  const guardada = await Appointment.findById(cita._id);
  assert.deepEqual(guardada.turns.map((t) => t.kind), ['enfermeria', 'doctor', 'enfermeria']);
  assert.deepEqual(guardada.turns.map((t) => t.order), [0, 1, 2]);
});
