/**
 * MOSTRADOR RECETA UN SUERO → LA CITA LE SALE SOLA A ENFERMERÍA.
 *
 * El caso es de todos los días: el paciente paga en caja, el cajero le escribe
 * el suero en su ficha y el paciente pasa a que se lo pongan. Pero en la agenda
 * de enfermería no aparecía nadie: el enfermero tenía que saberse el nombre,
 * buscar al paciente en la lista y entrar a su ficha a mano. Con dos o tres a la
 * vez, ahí es donde se pierde una aplicación o se le pone a quien no era.
 *
 * Lo que estos tests vigilan:
 *  1. Recetar un suero desde mostrador CREA la cita, abierta y con un turno de
 *     enfermería SIN dueño (lo toma el primero que lo vea).
 *  2. Esa cita sale en la bandeja de enfermería y se puede reclamar.
 *  3. La cita NO queda a nombre del cajero como si hubiera atendido: `doctor`
 *     vacío (de ahí salen las comisiones de médico) y sin cronómetro arrancado.
 *  4. Sin suero, mostrador sigue sin generar cita: documentar no es atender.
 *  5. Enfermería escribiendo lo mismo se comporta como siempre (cita cerrada,
 *     porque el suero ya se puso), no se le deja una tarea a sí misma.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
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

  const cajero = await crear('Caja', 'cajero');
  const enfermera = await crear('Enfer', 'enfermero');

  return { clinicId, userId, patient, cajero, enfermera };
}

/** Una línea de receta que ES un suero (la casilla que se marca a mano). */
const lineaSuero = (name = 'Suero vitamina C') => ({
  name,
  quantity: 1,
  isSerum: true,
  serumBase: { name: 'Cloruro', volumeMl: 250 },
  serumComponents: [{ name: 'Vitamina C', quantity: 2 }],
});

const guardarSeguimiento = (clinicId, userId, patientId, role, body = {}) =>
  H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, userId, { motivoConsulta: 'Suero', ...body },
      { role, params: { patientId: String(patientId) } }),
  );

// ───────────────────── el caso de mostrador ─────────────────────

test('el cajero receta un suero y la cita queda esperando a enfermería', async () => {
  const { clinicId, patient, cajero } = await seed();

  const r = await guardarSeguimiento(clinicId, cajero._id, patient._id, 'cajero', {
    recetaItems: [lineaSuero()],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const citas = await Appointment.find({ clinic: clinicId }).lean();
  assert.equal(citas.length, 1, 'la receta agenda');
  const cita = citas[0];

  assert.equal(String(cita.patient), String(patient._id));
  assert.equal(cita.status, 'asistida', 'el paciente está delante, no es una cita futura');
  assert.equal(String(cita.createdBy), String(cajero._id), 'la agendó mostrador');
  assert.equal(cita.createdByRole, 'cajero');
  assert.equal(cita.serviceName, 'Suero vitamina C', 'la agenda dice qué hay que poner');

  // El turno es de ENFERMERÍA y sin dueño: sale a la bandeja de todos.
  assert.equal(cita.turns.length, 1);
  assert.equal(cita.turns[0].kind, 'enfermeria');
  assert.equal(cita.turns[0].user ?? null, null, 'sin dueño: lo toma quien pueda');
  assert.equal(cita.turns[0].status, 'pendiente');
  assert.equal(cita.currentTurnKind, 'enfermeria');
  assert.equal(cita.currentTurnUser ?? null, null);

  // Y NO queda como si el cajero hubiera atendido.
  assert.equal(cita.doctor ?? null, null, 'mostrador no es el médico de la cita');
  assert.equal(
    cita.consultationStartedAt ?? null,
    null,
    'nadie ha empezado a atender: el reloj no corre',
  );

  // La respuesta lo dice para que la pantalla avise con las palabras correctas.
  assert.equal(r.payload.autoAppointment?.paraEnfermeria, true);
});

test('la cita del suero aparece en la bandeja de enfermería y se puede reclamar', async () => {
  const { clinicId, patient, cajero, enfermera } = await seed();
  await guardarSeguimiento(clinicId, cajero._id, patient._id, 'cajero', {
    recetaItems: [lineaSuero()],
  });

  const lista = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, enfermera._id, {}, { role: 'enfermero', query: {} }),
  );
  const citas = Array.isArray(lista.payload) ? lista.payload : lista.payload?.appointments || [];
  assert.equal(citas.length, 1, 'le sale sin tener que buscar al paciente');
  assert.equal(String(citas[0].patient?._id || citas[0].patient), String(patient._id));

  const reclamo = await H.runController(
    appt.nurseClaim,
    H.mockReq(clinicId, enfermera._id, {}, {
      role: 'enfermero', params: { id: String(citas[0]._id) },
    }),
  );
  assert.equal(reclamo.statusCode ?? 200, 200, JSON.stringify(reclamo.payload));

  const cita = await Appointment.findById(citas[0]._id).lean();
  assert.equal(String(cita.turns[0].user), String(enfermera._id), 'ya es suya');
  assert.ok(cita.turns[0].startedAt, 'y con su hora de inicio, la de verdad');
});

test('el suero recetado queda en la historia, listo para administrar', async () => {
  const { clinicId, patient, cajero } = await seed();
  await guardarSeguimiento(clinicId, cajero._id, patient._id, 'cajero', {
    recetaItems: [lineaSuero()],
  });

  const rec = await ClinicalRecord.findOne({ clinic: clinicId, patient: patient._id }).lean();
  const item = rec.followUps.slice(-1)[0].recetaItems[0];
  assert.equal(item.isSerum, true);
  assert.equal(item.serumBase.volumeMl, 250, 'la composición es lo que entra por la vena');
  assert.equal(item.administrations.length, 0, 'todavía no se ha puesto');
});

// ───────────────────── que no se rompa lo de antes ─────────────────────

test('sin suero, mostrador sigue sin generar ninguna cita', async () => {
  const { clinicId, patient, cajero } = await seed();

  const r = await guardarSeguimiento(clinicId, cajero._id, patient._id, 'cajero', {
    recetaItems: [{ name: 'Paracetamol 500mg', quantity: 10 }],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  assert.equal(
    await Appointment.countDocuments({ clinic: clinicId }),
    0,
    'documentar por otro no es mandar a nadie a enfermería',
  );
});

test('el enfermero que receta y pone el suero cierra su cita, no se deja tarea', async () => {
  const { clinicId, patient, enfermera } = await seed();

  await guardarSeguimiento(clinicId, enfermera._id, patient._id, 'enfermero', {
    recetaItems: [lineaSuero()],
  });

  const cita = await Appointment.findOne({ clinic: clinicId }).lean();
  assert.equal(cita.status, 'completada', 'lo que escribe enfermería ya está hecho');
  assert.equal(cita.turns[0].kind, 'enfermeria');
  assert.equal(String(cita.turns[0].user), String(enfermera._id), 'con su nombre');
  assert.equal(cita.turns[0].status, 'completado');
});

test('con cita de partida no se crea una segunda por el suero', async () => {
  const { clinicId, userId, patient, cajero, enfermera } = await seed();
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { steps: [{ kind: 'enfermeria', user: String(enfermera._id) }] },
      { params: { id: String(cita._id) } }),
  );

  const r = await guardarSeguimiento(clinicId, cajero._id, patient._id, 'cajero', {
    appointmentId: String(cita._id),
    recetaItems: [lineaSuero()],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  assert.equal(await Appointment.countDocuments({ clinic: clinicId }), 1, 'sigue habiendo una sola');
  assert.equal(r.payload.autoAppointment, undefined, 'no se anuncia ninguna cita nueva');
});

test('si el paciente ya está esperando a enfermería, no se le agenda otra vez', async () => {
  const { clinicId, patient, cajero } = await seed();

  await guardarSeguimiento(clinicId, cajero._id, patient._id, 'cajero', {
    recetaItems: [lineaSuero('Suero A')],
  });
  const r = await guardarSeguimiento(clinicId, cajero._id, patient._id, 'cajero', {
    recetaItems: [lineaSuero('Suero B')],
  });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const citas = await Appointment.find({ clinic: clinicId }).lean();
  assert.equal(citas.length, 1, 'una fila por paciente en la cola, no una por receta');
  // Y se sigue avisando de que enfermería lo tiene, apuntando a la que ya existe.
  assert.equal(r.payload.autoAppointment?.paraEnfermeria, true);
  assert.equal(String(r.payload.autoAppointment._id), String(citas[0]._id));
});
