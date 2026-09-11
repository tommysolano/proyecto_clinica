/**
 * LOS AVISOS DE ENFERMERÍA DICEN A QUIÉN Y LLEVAN A DONDE SE ATIENDE.
 *
 * En la campana del enfermero se apilaban avisos indistinguibles —«El doctor
 * terminó su parte de la consulta», «Mostrador acaba de recetar un suero»— sin
 * decir de qué paciente hablaban, y al tocarlos soltaban en la agenda, con
 * decenas de citas del día, a buscar otra vez la que el aviso ya identificaba.
 *
 * Lo que estos tests fijan:
 *  1. El nombre del paciente encabeza SIEMPRE el cuerpo del aviso.
 *  2. El enlace apunta a los seguimientos DE ESE paciente, con su cita.
 *  3. Vale para los tres caminos por los que llega trabajo a enfermería:
 *     recepción asigna, el doctor termina su turno, y mostrador receta un suero.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Notification = require('../models/Notification');
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
    clinic: clinicId, firstName: 'Jorge', lastName: 'Avilés Villón', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });

  return {
    clinicId,
    patient,
    cajero: await crear('Caja', 'cajero'),
    doctor: await crear('DocA', 'doctor'),
    enfermera: await crear('Enfer', 'enfermero'),
  };
}

/** El aviso de enfermería que llegó a la campana (el último). */
const avisoEnfermeria = () =>
  Notification.findOne({ type: 'appointment_nursing' }).sort({ createdAt: -1 }).lean();

/** Las dos cosas que un aviso tiene que traer, en un solo sitio. */
function assertAvisoUtil(aviso, { cita, patientId }) {
  assert.ok(aviso, 'el aviso llegó a la campana');
  assert.match(aviso.body, /^Jorge Avilés Villón/i, `el paciente encabeza el aviso: "${aviso.body}"`);
  assert.equal(
    aviso.meta?.url,
    `/patients/${patientId}?tab=seguimientos&appointment=${cita}`,
    'lleva a los seguimientos del paciente, no a la agenda'
  );
}

test('recepción manda la cita a enfermería: el aviso trae el paciente y su ficha', async () => {
  const { clinicId, patient, cajero, enfermera } = await seed();

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(),
    startTime: '14:28', status: 'pendiente', serviceName: 'Sueroterapia',
    createdBy: cajero._id,
  });

  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, cajero._id, { steps: [{ kind: 'enfermeria', serviceName: 'Sueroterapia' }] },
      { role: 'cajero', params: { id: String(cita._id) } }),
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const aviso = await avisoEnfermeria();
  assertAvisoUtil(aviso, { cita: cita._id, patientId: patient._id });
  // El servicio y la hora siguen ahí: es lo que deja saber a qué se va.
  assert.match(aviso.body, /Sueroterapia/);
  assert.match(aviso.body, /14:28/);
  assert.equal(String(aviso.user), String(enfermera._id), 'es de quien puede atenderla');
});

test('el doctor termina y pasa a enfermería: el aviso dice a quién hay que atender', async () => {
  const { clinicId, patient, cajero, doctor, enfermera } = await seed();

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(),
    startTime: '09:00', status: 'pendiente', createdBy: cajero._id,
  });
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, cajero._id,
      { steps: [{ kind: 'doctor', user: String(doctor._id) }, { kind: 'enfermeria', serviceName: 'Detox' }] },
      { role: 'cajero', params: { id: String(cita._id) } }),
  );
  await Notification.deleteMany({}); // solo interesa el aviso del relevo

  const r = await H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, doctor._id,
      { motivoConsulta: 'Control', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const aviso = await avisoEnfermeria();
  assertAvisoUtil(aviso, { cita: cita._id, patientId: patient._id });
  assert.match(aviso.body, /Detox/, 'el servicio del turno, no el genérico de la cita');
  assert.equal(String(aviso.user), String(enfermera._id));
});

test('mostrador receta un suero: el aviso trae paciente y suero, y abre su ficha', async () => {
  const { clinicId, patient, cajero } = await seed();

  const r = await H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, cajero._id,
      {
        motivoConsulta: 'Suero',
        recetaItems: [{
          name: 'Suero vitamina C', quantity: 1, isSerum: true,
          serumBase: { name: 'Cloruro', volumeMl: 250 },
        }],
      },
      { role: 'cajero', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const cita = await Appointment.findOne({ clinic: clinicId }).lean();
  const aviso = await avisoEnfermeria();
  assertAvisoUtil(aviso, { cita: cita._id, patientId: patient._id });
  assert.match(aviso.body, /Suero vitamina C/, 'dice QUÉ hay que poner');
});

// ─────────── La sede que eligió, y el aviso que se apaga ───────────

const push = require('../utils/pushNotifications');

test('T-avisos) el aviso dice de QUÉ cita es, y al reclamarla se apaga', async () => {
  const { clinicId, patient, cajero, enfermera } = await seed();

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(),
    startTime: '14:28', status: 'pendiente', serviceName: 'Sueroterapia',
    createdBy: cajero._id,
  });
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, cajero._id, { steps: [{ kind: 'enfermeria', serviceName: 'Sueroterapia' }] },
      { role: 'cajero', params: { id: String(cita._id) } }),
  );
  const aviso = await avisoEnfermeria();
  assert.equal(String(aviso.meta?.appointment || ''), String(cita._id), 'el aviso identifica su cita');

  // Y al reclamarla, TODOS los avisos de esa cita se van de las campanas.
  const r = await H.runController(appt.nurseClaim, H.mockReq(clinicId, enfermera._id, {},
    { role: 'enfermero', params: { id: String(cita._id) } }));
  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  const quedan = await Notification.countDocuments({ type: 'appointment_nursing', 'meta.appointment': cita._id });
  assert.equal(quedan, 0, 'el paciente ya tiene quien lo atienda: la campana se calla');
});

test('T-avisos) la enfermera «en todas» solo recibe avisos de la sede que eligió', async () => {
  const { clinicId: central, userId } = await H.seedClinic();
  const Clinic = require('../models/Clinic');
  await Clinic.create({ _id: central, name: 'Central' });
  const extension = (await Clinic.create({ name: 'Extension' }))._id;

  const rotativa = await User.create({
    name: 'EnfRota', email: 'rota@t.com', password: 'secreto123',
    clinics: [{ clinic: central, role: 'enfermero' }],
    worksInAllClinics: true,
    // Su sesión está puesta en Central: es donde está trabajando.
    activeClinicId: central,
  });

  await push.notificarRol(extension, 'enfermero', {
    type: 'appointment_nursing', title: 'Cita para enfermería', body: 'x', url: '/x',
  });
  assert.equal(
    await Notification.countDocuments({ user: rotativa._id }),
    0,
    'trabaja en Central: el aviso de Extensión no le suena'
  );

  await push.notificarRol(central, 'enfermero', {
    type: 'appointment_nursing', title: 'Cita para enfermería', body: 'x', url: '/x',
  });
  assert.equal(
    await Notification.countDocuments({ user: rotativa._id }),
    1,
    'de SU sede sí se entera'
  );
});

// ─────────── LA CAMPANA NO ATURDE (sep-2026) ───────────
//
// Queja literal de enfermería: «tengo notificaciones de citas de días pasados».
// Casi nada apagaba un aviso —solo nurseClaim— y el listado no miraba el estado
// de la cita: lo atendido, cancelado y ausente seguía sonando para siempre.

const notif = require('../controllers/notificationController');

/** La campana tal como la lee la app: lista + contador de no leídas. */
const campanaDe = (clinicId, userId, role = 'enfermero') =>
  H.runController(
    notif.list,
    H.mockReq(clinicId, userId, {}, { role, query: {} }),
  );

const asignarEnfermeria = (clinicId, userId, citaId, paso = {}) =>
  H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { steps: [{ kind: 'enfermeria', ...paso }] },
      { role: 'cajero', params: { id: String(citaId) } }),
  );

test('T-avisos) una cita completada deja de sonar, aunque el aviso siga en Mongo', async () => {
  const { clinicId, patient, cajero, enfermera } = await seed();
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(),
    startTime: '09:00', status: 'pendiente', createdBy: cajero._id,
  });
  await asignarEnfermeria(clinicId, cajero._id, cita._id);

  let r = await campanaDe(clinicId, enfermera._id);
  assert.equal(r.payload.unread, 1, 'la cita espera: el aviso suena');

  // La cerraron por un camino que no pasa por reclamar (mostrador, a mano).
  await Appointment.updateOne(
    { _id: cita._id },
    { $set: { status: 'completada', currentTurnKind: null, currentTurnUser: null } },
  );
  r = await campanaDe(clinicId, enfermera._id);
  assert.equal(r.payload.unread, 0, 'ya no espera a nadie: la campana se calla');
  assert.equal(r.payload.items.length, 0, 'y de la lista también desaparece');
});

test('T-avisos) marcar no-show apaga el aviso de la cita', async () => {
  const { clinicId, patient, cajero } = await seed();
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(),
    startTime: '09:00', status: 'pendiente', createdBy: cajero._id,
  });
  await asignarEnfermeria(clinicId, cajero._id, cita._id);
  assert.equal(
    await Notification.countDocuments({ type: 'appointment_nursing' }), 1,
    'el aviso nació',
  );

  await H.runController(
    appt.markNoShow,
    H.mockReq(clinicId, cajero._id, {}, { role: 'cajero', params: { id: String(cita._id) } }),
  );
  assert.equal(
    await Notification.countDocuments({ type: 'appointment_nursing' }), 0,
    'nadie va a atenderla: el aviso se va de verdad, no solo de la vista',
  );
});

test('T-avisos) las citas de días pasados no avisan: el trabajo ya está en la agenda', async () => {
  const { clinicId, patient, cajero } = await seed();
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(-3),
    startTime: '09:00', status: 'pendiente', createdBy: cajero._id,
  });
  await asignarEnfermeria(clinicId, cajero._id, cita._id);

  assert.equal(
    await Notification.countDocuments({ type: 'appointment_nursing' }), 0,
    're-asignar una cita vencida no es noticia nueva',
  );
});

test('T-avisos) si el turno pasa a otra enfermera, el aviso anterior deja de sonar para la primera', async () => {
  const { clinicId, patient, cajero, enfermera } = await seed();
  const otra = await User.create({
    name: 'Enf2', email: 'enf2@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(),
    startTime: '09:00', status: 'pendiente', createdBy: cajero._id,
  });

  // Nombrada a la primera: suena para ella.
  await asignarEnfermeria(clinicId, cajero._id, cita._id, { user: String(enfermera._id) });
  let r = await campanaDe(clinicId, enfermera._id);
  assert.equal(r.payload.unread, 1);

  // Recepción se equivocó y se la pasa a la otra: nuevo aviso para la otra, y
  // el de la primera queda en Mongo pero YA NO SUENA (el turno ya no es suyo).
  await asignarEnfermeria(clinicId, cajero._id, cita._id, { user: String(otra._id) });
  r = await campanaDe(clinicId, enfermera._id);
  assert.equal(r.payload.unread, 0, 'el turno ya es de otra: a ella no le suena');
  r = await campanaDe(clinicId, otra._id);
  assert.equal(r.payload.unread, 1, 'a quien le toca ahora, sí');
});

test('T-avisos) un turno abierto suena para todos hasta que alguien lo reclama', async () => {
  const { clinicId, patient, cajero, enfermera } = await seed();
  const otra = await User.create({
    name: 'Enf3', email: 'enf3@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(),
    startTime: '09:00', status: 'pendiente', createdBy: cajero._id,
  });
  await asignarEnfermeria(clinicId, cajero._id, cita._id);

  // Turno sin dueño: les suena a las dos.
  assert.equal((await campanaDe(clinicId, enfermera._id)).payload.unread, 1);
  assert.equal((await campanaDe(clinicId, otra._id)).payload.unread, 1);

  // Una la reclama: para las dos se apaga (la cita ya tiene quien la atienda).
  await H.runController(
    appt.nurseClaim,
    H.mockReq(clinicId, enfermera._id, {}, { role: 'enfermero', params: { id: String(cita._id) } }),
  );
  assert.equal((await campanaDe(clinicId, enfermera._id)).payload.unread, 0);
  assert.equal((await campanaDe(clinicId, otra._id)).payload.unread, 0);
});
