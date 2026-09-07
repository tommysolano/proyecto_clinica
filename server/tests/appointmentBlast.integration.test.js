/**
 * RECORDATORIOS DE CITAS: envío masivo a las citas de la agenda.
 *
 * Lo que se protege aquí es lo mismo que en el envío masivo de contactos, porque
 * son envíos de PLANTILLA y Meta cobra cada uno:
 *
 *   1. un mensaje por paciente y por cita (nada de dos disparadores = dos cobros);
 *   2. quien no puede recibirlo queda CONTADO, no desaparecido en silencio;
 *   3. apretar el botón dos veces no manda el recordatorio dos veces;
 *   4. y si la cita se cancela después de encolar, el recordatorio NO sale — que
 *      era el agujero real: la inscripción esperaba su turno de goteo sin
 *      marcador de espera, y el barrido de citas canceladas no la veía.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const AppointmentBlast = require('../models/AppointmentBlast');
const Patient = require('../models/Patient');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const { enrollAppointments } = require('../utils/appointmentBlastRunner');
const { cancelWaitingEnrollmentsForAppointment, syncEnrollmentsForAppointment } = require('../utils/workflowEngine');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Mañana a mediodía: es el día del recordatorio típico. */
function manana() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(12, 0, 0, 0);
  return d;
}

function unTrigger(clinicId) {
  return Workflow.create({
    clinic: clinicId,
    name: 'Recordatorio del día siguiente',
    active: true,
    trigger: { type: 'appointment_bulk' },
    steps: [{ type: 'send_template', templateName: 'recordatorio_cita' }],
  });
}

/** Diagrama con DOS nodos disparadores "Citas de la agenda". */
function dosTriggers(clinicId) {
  return Workflow.create({
    clinic: clinicId,
    name: 'Recordatorio con dos disparadores',
    active: true,
    triggers: [{ type: 'appointment_bulk' }],
    steps: [],
    nodes: [
      { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_bulk' }] } },
      { id: 'n1', type: 'send_template', position: { x: 0, y: 130 }, data: { templateName: 'recordatorio_cita' } },
      { id: 't2', type: 'trigger', position: { x: 300, y: 0 }, data: { triggers: [{ type: 'appointment_bulk' }] } },
      { id: 'n2', type: 'send_template', position: { x: 300, y: 130 }, data: { templateName: 'recordatorio_cita' } },
    ],
    edges: [
      { id: 'e1', source: 't1', target: 'n1', sourceHandle: 'default' },
      { id: 'e2', source: 't2', target: 'n2', sourceHandle: 'default' },
    ],
  });
}

async function makePatient(clinicId, overrides = {}) {
  return Patient.create({
    clinic: clinicId,
    firstName: 'Ana',
    lastName: 'Vera',
    phone: '0999111222',
    ...overrides,
  });
}

async function makeAppointment(clinicId, patient, overrides = {}) {
  return Appointment.create({
    clinic: clinicId,
    patient: patient._id,
    date: manana(),
    startTime: '10:00',
    status: 'pendiente',
    ...overrides,
  });
}

function makeBlast(clinicId, userId, wf, citas, extra = {}) {
  return AppointmentBlast.create({
    clinic: clinicId,
    name: 'Citas de mañana',
    workflows: [wf._id],
    appointments: citas.map((c) => c._id),
    createdBy: userId,
    ...extra,
  });
}

// ─────────── 1. lo que sí se envía ───────────

test('inscribe las citas del día, escalonadas, y cada una sabe de qué cita habla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const p1 = await makePatient(clinicId, { firstName: 'Ana', phone: '0999111222' });
  const p2 = await makePatient(clinicId, { firstName: 'Luis', phone: '0988333444' });
  const c1 = await makeAppointment(clinicId, p1, { startTime: '08:00' });
  const c2 = await makeAppointment(clinicId, p2, { startTime: '15:30' });

  const blast = await makeBlast(clinicId, userId, wf, [c1, c2], { dripSeconds: 30 });
  await enrollAppointments(blast);

  assert.equal(blast.enrolled, 2);
  const insc = await WorkflowEnrollment.find({ workflow: wf._id }).sort({ nextRunAt: 1 });
  assert.equal(insc.length, 2);

  // La cita viaja en el contexto: de ahí salen {{fecha}}, {{hora}}, {{servicio}},
  // {{doctor}} y {{sede}}, y de ahí cuelgan el reagendamiento y la cancelación.
  assert.equal(String(insc[0].context.appointmentId), String(c1._id));
  assert.ok(insc[0].context.appointmentDate, 'sin appointmentDate un wait_until no sabría a qué esperar');
  assert.equal(insc[0].context.eventType, 'appointment_bulk');
  assert.equal(String(insc[0].context.eventClinicId), String(clinicId));

  // 'waiting' y NO 'active': el job de rescate reintenta cualquier 'active'
  // parada y dispararía toda la tanda de golpe (la ráfaga que el goteo evita).
  assert.equal(insc[0].status, 'waiting');
  const separacion = insc[1].nextRunAt - insc[0].nextRunAt;
  assert.equal(separacion, 30_000, 'el goteo separa un mensaje del siguiente');
});

test('el paciente con DOS citas el mismo día recibe UN solo recordatorio', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const p = await makePatient(clinicId);
  // La consulta y, después, el suero de enfermería: dos citas de verdad, pero un
  // solo WhatsApp. Se queda la primera, que es la que marca cuándo salir de casa.
  const temprano = await makeAppointment(clinicId, p, { startTime: '08:00' });
  const tarde = await makeAppointment(clinicId, p, { startTime: '16:00' });

  const blast = await makeBlast(clinicId, userId, wf, [temprano, tarde]);
  await enrollAppointments(blast);

  assert.equal(blast.enrolled, 1);
  assert.equal(blast.skippedDuplicate, 1);
  const insc = await WorkflowEnrollment.findOne({ workflow: wf._id });
  assert.equal(String(insc.context.appointmentId), String(temprano._id));
  assert.match(blast.warning, /mismo paciente/i);
});

// ─────────── 2. a quién NO le llega, y que se sepa ───────────

test('sin teléfono y dado de baja: no se inscriben, y el envío lo dice', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const bueno = await makePatient(clinicId, { phone: '0999111222' });
  const sinTel = await makePatient(clinicId, { firstName: 'Sin', phone: '', whatsapp: '' });
  const deBaja = await makePatient(clinicId, {
    firstName: 'Baja',
    phone: '0977555666',
    marketing: { optOutAt: new Date(), optOutReason: 'pidió no recibir' },
  });

  const citas = [
    await makeAppointment(clinicId, bueno, { startTime: '09:00' }),
    await makeAppointment(clinicId, sinTel, { startTime: '10:00' }),
    await makeAppointment(clinicId, deBaja, { startTime: '11:00' }),
  ];

  const blast = await makeBlast(clinicId, userId, wf, citas);
  await enrollAppointments(blast);

  assert.equal(blast.enrolled, 1);
  assert.equal(blast.skippedNoPhone, 1);
  assert.equal(blast.skippedOptOut, 1);
  assert.match(blast.warning, /no tiene teléfono/i);
  assert.match(blast.warning, /dado de baja/i);
});

// ─────────── 3. un mensaje, aunque el botón se apriete dos veces ───────────

test('diagrama con DOS disparadores "Citas de la agenda": una sola inscripción y un aviso', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await dosTriggers(clinicId);
  const p = await makePatient(clinicId);
  const cita = await makeAppointment(clinicId, p);

  const blast = await makeBlast(clinicId, userId, wf, [cita]);
  await enrollAppointments(blast);

  assert.equal(blast.enrolled, 1, 'dos disparadores no pueden ser dos cobros de plantilla');
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 1);
  assert.match(blast.warning, /disparadores/i);
});

test('reprocesar el MISMO lote (rescate tras un reinicio) no manda el recordatorio dos veces', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const p = await makePatient(clinicId);
  const cita = await makeAppointment(clinicId, p);

  const blast = await makeBlast(clinicId, userId, wf, [cita]);
  await enrollAppointments(blast);
  blast.enrolled = 0;
  blast.skippedDuplicate = 0;
  await enrollAppointments(blast);

  assert.equal(blast.enrolled, 0);
  assert.equal(blast.skippedDuplicate, 1);
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 1);
});

test('el recordatorio automático de "Cita agendada" ya en cola bloquea el envío manual del mismo flujo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const p = await makePatient(clinicId);
  const cita = await makeAppointment(clinicId, p);

  // Lo dejó el disparador automático al agendar: está esperando su wait_until.
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, patient: p._id, status: 'waiting',
    nextRunAt: new Date(Date.now() + 3600e3),
    context: { phone: p.phone, appointmentId: String(cita._id), eventType: 'appointment_created', waitStepIndex: 0 },
  });

  const blast = await makeBlast(clinicId, userId, wf, [cita]);
  await enrollAppointments(blast);

  assert.equal(blast.enrolled, 0, 'mandarlo a mano encima del automático es cobrar el mensaje dos veces');
  assert.equal(blast.skippedDuplicate, 1);
});

test('cancelPending anula lo que seguía en cola de la tanda anterior; lo ya enviado no se toca', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const p = await makePatient(clinicId);
  const cita = await makeAppointment(clinicId, p);

  // Restos de ayer: uno esperando su turno de goteo y otro que ya salió.
  const enCola = await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'waiting', nextRunAt: new Date(Date.now() + 7200e3),
    context: { phone: '0966000001', eventType: 'appointment_bulk', blastId: 'tanda-de-ayer' },
  });
  const salido = await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'done',
    context: { phone: '0966000002', eventType: 'appointment_bulk', blastId: 'tanda-de-ayer' },
  });

  const blast = await makeBlast(clinicId, userId, wf, [cita], { cancelPending: true });
  await enrollAppointments(blast);

  assert.equal(blast.cancelledPending, 1);
  assert.equal((await WorkflowEnrollment.findById(enCola._id)).status, 'cancelled');
  assert.equal((await WorkflowEnrollment.findById(salido._id)).status, 'done');
});

// ─────────── 4. la cita manda: si cambia, el recordatorio cambia ───────────

test('cancelar la cita anula el recordatorio que esperaba su turno de goteo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const p = await makePatient(clinicId);
  const cita = await makeAppointment(clinicId, p);

  const blast = await makeBlast(clinicId, userId, wf, [cita], { dripSeconds: 3600 });
  await enrollAppointments(blast);
  assert.equal(blast.enrolled, 1);

  // El paciente llama a las 5 y cancela; el recordatorio salía a las 6.
  await cancelWaitingEnrollmentsForAppointment({ appointmentId: String(cita._id) });

  const insc = await WorkflowEnrollment.findOne({ workflow: wf._id });
  assert.equal(insc.status, 'cancelled', 'no se recuerda una cita que ya no existe');
  assert.match(insc.log.at(-1).info, /cancelada/i);
});

test('reagendar la cita mueve la fecha que lleva el recordatorio en el contexto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const p = await makePatient(clinicId);
  const cita = await makeAppointment(clinicId, p);

  const blast = await makeBlast(clinicId, userId, wf, [cita]);
  await enrollAppointments(blast);

  const nueva = new Date(manana().getTime() + 3 * 24 * 3600e3);
  await syncEnrollmentsForAppointment({ appointmentId: String(cita._id), appointmentDate: nueva });

  const insc = await WorkflowEnrollment.findOne({ workflow: wf._id });
  assert.equal(new Date(insc.context.appointmentDate).getTime(), nueva.getTime());
});
