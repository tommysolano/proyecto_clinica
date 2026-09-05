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

// ───────────── la nota de recepción ─────────────

test('lo que recepción escribe al asignar acaba en Observaciones del paciente', async () => {
  const PatientObservation = require('../models/PatientObservation');
  const { clinicId, userId, patient, docA, cita } = await seed();

  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, {
      steps: [{ kind: 'doctor', user: String(docA._id) }],
      observation: '  Vino con la mamá; pide factura a nombre de la empresa  ',
    }, params(cita._id)),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const obs = await PatientObservation.find({ patient: patient._id }).lean();
  assert.equal(obs.length, 1);
  assert.equal(obs[0].text, 'Vino con la mamá; pide factura a nombre de la empresa');
  assert.equal(String(obs[0].createdBy), String(userId), 'queda a nombre de quien la escribió');
  // La nota es del PACIENTE, no de la cita: no se copia al motivo de consulta,
  // que es dato clínico y lo escribe quien atiende.
  const guardada = await Appointment.findById(cita._id).lean();
  assert.notEqual(guardada.reason, obs[0].text);
});

test('asignar sin escribir nada no crea una observación vacía', async () => {
  const PatientObservation = require('../models/PatientObservation');
  const { clinicId, userId, patient, docA, cita } = await seed();

  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, {
      steps: [{ kind: 'doctor', user: String(docA._id) }],
      observation: '   ',
    }, params(cita._id)),
  );

  assert.equal(await PatientObservation.countDocuments({ patient: patient._id }), 0);
});

// ───────────── el reloj de cada turno ─────────────

test('cada doctor arranca su propio cronómetro, no hereda el del anterior', async () => {
  const { clinicId, userId, patient, docA, docB, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, {
      steps: [{ kind: 'doctor', user: String(docA._id) }, { kind: 'doctor', user: String(docB._id) }],
    }, params(cita._id)),
  );

  // El primero abre la consulta.
  await H.runController(
    appt.startConsultation,
    H.mockReq(clinicId, docA._id, {}, { role: 'doctor', ...params(cita._id) }),
  );
  let guardada = await Appointment.findById(cita._id);
  const inicioA = guardada.turns[0].startedAt;
  assert.ok(inicioA, 'el turno del primero guarda su hora de inicio');
  assert.equal(guardada.turns[1].startedAt, null, 'el segundo todavía no empezó');

  // Termina y pasa al segundo.
  await H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, docA._id, { descripcion: 'Primera parte', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  // El segundo abre: su turno estrena reloj.
  await H.runController(
    appt.startConsultation,
    H.mockReq(clinicId, docB._id, {}, { role: 'ginecologia', ...params(cita._id) }),
  );
  guardada = await Appointment.findById(cita._id);
  assert.ok(guardada.turns[1].startedAt, 'el segundo estrena el suyo');
  assert.ok(
    guardada.turns[1].startedAt.getTime() >= inicioA.getTime(),
    'y arranca cuando él entra, no antes',
  );
  // El del primero queda intacto, para saber cuánto duró su parte.
  assert.equal(String(guardada.turns[0].startedAt), String(inicioA));
});

test('asignar una cita de MAÑANA no la da por asistida', async () => {
  const { clinicId, userId, docA, patient } = await seed();
  const manana = new Date(H.docDate());
  manana.setDate(manana.getDate() + 1);
  const futura = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: manana, startTime: '09:00', status: 'pendiente',
  });

  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { steps: [{ kind: 'doctor', user: String(docA._id) }] }, params(futura._id)),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(futura._id).lean();
  // Dejar preparado el doctor de mañana no puede decir que el paciente ya vino:
  // si no aparece, autoNoShow tiene que poder marcarla ausente como cualquiera.
  assert.equal(guardada.status, 'pendiente');
  assert.equal(guardada.turns.length, 1, 'pero el turno sí queda asignado');
});

test('2 doctores + enfermería: cuando los dos terminan, la cita LLEGA a enfermería', async () => {
  const { clinicId, userId, patient, docA, docB, enf1, cita } = await seed();

  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, {
      steps: [
        { kind: 'doctor', user: String(docA._id) },
        { kind: 'doctor', user: String(docB._id) },
        { kind: 'enfermeria' },
      ],
    }, params(cita._id)),
  );

  let guardada = await Appointment.findById(cita._id).lean();
  assert.deepEqual(
    guardada.turns.map((t) => t.kind),
    ['doctor', 'doctor', 'enfermeria'],
    'los tres turnos quedan guardados',
  );

  const atender = (doc, role, texto) =>
    H.runController(
      clinicalRecords.addFollowUp,
      H.mockReq(clinicId, doc._id, { descripcion: texto, appointmentId: String(cita._id) },
        { role, params: { patientId: String(patient._id) } }),
    );

  await atender(docA, 'doctor', 'Primera parte');
  await atender(docB, 'ginecologia', 'Segunda parte');

  guardada = await Appointment.findById(cita._id).lean();
  // La cita NO puede darse por terminada: falta enfermería.
  assert.equal(guardada.status, 'asistida', 'sigue abierta hasta que enfermería la atienda');
  assert.equal(guardada.currentTurnKind, 'enfermeria');

  // Y tiene que estar en la bandeja de los enfermeros.
  const r = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', query: {} }),
  );
  const lista = Array.isArray(r.payload) ? r.payload : r.payload?.appointments || [];
  assert.deepEqual(lista.map((a) => String(a._id)), [String(cita._id)], 'le llega a enfermería');
});

test('reasignar NO borra el turno de enfermería que estaba pendiente', async () => {
  const { clinicId, userId, docA, docB, cita } = await seed();
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, {
      steps: [{ kind: 'doctor', user: String(docA._id) }, { kind: 'enfermeria' }],
    }, params(cita._id)),
  );

  // Recepción reabre y añade un segundo doctor. Si el modal reconstruye la cola
  // sin arrastrar enfermería, el paciente se queda sin ella y nadie se entera.
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, {
      steps: [
        { kind: 'doctor', user: String(docA._id) },
        { kind: 'doctor', user: String(docB._id) },
        { kind: 'enfermeria' },
      ],
    }, params(cita._id)),
  );

  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(
    guardada.turns.filter((t) => t.kind === 'enfermeria').length,
    1,
    'enfermería sigue ahí, y una sola vez',
  );
});

test('enfermería cierra su turno SIN escribir seguimiento y la cita pasa al doctor', async () => {
  const { clinicId, userId, docA, enf1, cita } = await seed();
  // Signos vitales primero, doctor después.
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, {
      steps: [{ kind: 'enfermeria' }, { kind: 'doctor', user: String(docA._id) }],
    }, params(cita._id)),
  );

  await H.runController(appt.nurseClaim, H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', ...params(cita._id) }));

  // Enfermería ya no redacta la consulta: termina desde la agenda.
  const r = await H.runController(
    appt.nurseComplete,
    H.mockReq(clinicId, enf1._id, {}, { role: 'enfermero', ...params(cita._id) }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.turns[0].status, 'completado', 'su turno queda cerrado');
  // Y NO se da por terminada: el doctor todavía tiene que ver al paciente.
  assert.equal(guardada.status, 'asistida');
  assert.equal(guardada.currentTurnKind, 'doctor');
  assert.equal(String(guardada.currentTurnUser), String(docA._id));
});

// ───────────── asistió SIN repartir la atención ─────────────

/**
 * QUIÉN VIENE Y QUIÉN LE ATIENDE SON DOS PREGUNTAS DISTINTAS.
 *
 * Reclamo real (5-sep-2026): para corregir una cita marcada como ausente hubo
 * que asignarle un doctor, porque «Asignar atención» era la única puerta que
 * dejaba la cita en 'asistida' y exige al menos un profesional en la cola. Eso
 * obliga a inventarse quién atiende para poder decir que el paciente vino.
 */
test('se marca asistió sin elegir a nadie, y sirve para corregir un "no asistió"', async () => {
  const { clinicId, userId, cita } = await seed();
  await Appointment.updateOne({ _id: cita._id }, { status: 'no_asistio' });

  const r = await H.runController(
    appt.markAttended,
    H.mockReq(clinicId, userId, {}, params(cita._id)),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(cita._id);
  assert.equal(guardada.status, 'asistida');
  assert.equal(guardada.doctor, null, 'no se inventa un doctor para poder marcar la asistencia');
  assert.equal(guardada.turns.length, 0, 'tampoco se crea ningún turno');
});

test('asignar la atención SIGUE exigiendo a alguien: no es la misma pregunta', async () => {
  const { clinicId, userId, cita } = await seed();

  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { steps: [] }, params(cita._id)),
  );
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.equal((await Appointment.findById(cita._id)).status, 'pendiente');
});
