/**
 * VER LA RECETA DE UNA CITA CONCRETA, desde la agenda.
 *
 * Hasta ahora, para saber qué le recetaron a un paciente en la visita del martes
 * había que abrir su ficha y buscar el seguimiento por fecha entre todos los
 * suyos. Con dos consultas el mismo día —o con la enfermera y el doctor
 * escribiendo cada uno lo suyo— eso es adivinar, y una receta no se adivina.
 *
 * El vínculo exacto ya existía y no se usaba: cada turno guarda el `_id` del
 * seguimiento que escribió (`turns[].followUp`). Lo que se vigila aquí es que se
 * use ESE, que el respaldo por fecha no mezcle consultas de dos profesionales
 * distintos, y que la consulta privada del terapeuta no salga por esta puerta.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const appt = require('../controllers/appointmentController');
const records = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez' });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });
  const docA = await crear('DocA', 'doctor');
  const docB = await crear('DocB', 'ginecologia');

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });
  return { clinicId, userId, patient, docA, docB, cita };
}

const asignar = (clinicId, userId, citaId, doctores) =>
  H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, userId, { doctors: doctores.map(String) }, { params: { id: String(citaId) } }),
  );

const escribir = (clinicId, quien, patientId, body, role = 'doctor') =>
  H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, quien, body, { role, params: { patientId: String(patientId) } }),
  );

const consultaDe = (clinicId, userId, citaId, role = 'cajero') =>
  H.runController(
    records.getFollowUpsByAppointment,
    H.mockReq(clinicId, userId, {}, { role, params: { appointmentId: String(citaId) } }),
  );

test('R1) devuelve la receta que se escribió EN ESA cita', async () => {
  const { clinicId, userId, patient, docA, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [docA._id]));
  ok(await escribir(clinicId, docA._id, patient._id, {
    motivoConsulta: 'Dolor de garganta',
    appointmentId: String(cita._id),
    recetaItems: [{ name: 'Amoxicilina', quantity: 1, dose: '500mg', frequency: 'cada 8 horas' }],
  }));

  const r = ok(await consultaDe(clinicId, userId, cita._id));
  assert.equal(r.followUps.length, 1);
  assert.equal(r.followUps[0].motivoConsulta, 'Dolor de garganta');
  assert.equal(r.followUps[0].recetaItems[0].name, 'Amoxicilina');
  assert.equal(r.followUps[0].recetaItems[0].frequency, 'cada 8 horas');
  assert.equal(r.aproximado, false, 'viene sellada con la cita: es exacta');
  assert.equal(r.followUps[0].createdBy?.name, 'DocA', 'y dice quién la escribió');
});

/**
 * LO QUE NO SE PUEDE HACER CON LA FECHA: el mismo paciente, el mismo día, dos
 * citas y dos doctores. Buscar por fecha devolvería las dos consultas mezcladas.
 */
test('R2) con dos citas el mismo día, cada una devuelve LA SUYA', async () => {
  const { clinicId, userId, patient, docA, docB, cita } = await seed();
  const cita2 = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '16:00', status: 'pendiente',
  });

  ok(await asignar(clinicId, userId, cita._id, [docA._id]));
  ok(await asignar(clinicId, userId, cita2._id, [docB._id]));
  ok(await escribir(clinicId, docA._id, patient._id, {
    motivoConsulta: 'De la mañana', appointmentId: String(cita._id),
  }));
  ok(await escribir(clinicId, docB._id, patient._id, {
    motivoConsulta: 'De la tarde', appointmentId: String(cita2._id),
  }, 'ginecologia'));

  const manana = ok(await consultaDe(clinicId, userId, cita._id));
  assert.deepEqual(manana.followUps.map((f) => f.motivoConsulta), ['De la mañana']);

  const tarde = ok(await consultaDe(clinicId, userId, cita2._id));
  assert.deepEqual(tarde.followUps.map((f) => f.motivoConsulta), ['De la tarde']);
});

test('R3) con varios profesionales en la cita salen los dos partes', async () => {
  const { clinicId, userId, patient, docA, docB, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [docA._id, docB._id]));

  ok(await escribir(clinicId, docA._id, patient._id, {
    motivoConsulta: 'Primera parte', appointmentId: String(cita._id),
  }));
  ok(await escribir(clinicId, docB._id, patient._id, {
    motivoConsulta: 'Segunda parte', appointmentId: String(cita._id),
  }, 'ginecologia'));

  const r = ok(await consultaDe(clinicId, userId, cita._id));
  assert.deepEqual(r.followUps.map((f) => f.motivoConsulta), ['Primera parte', 'Segunda parte']);
});

test('R4) una cita sin nada escrito lo dice, no inventa', async () => {
  const { clinicId, userId, docA, cita } = await seed();
  ok(await asignar(clinicId, userId, cita._id, [docA._id]));

  const r = ok(await consultaDe(clinicId, userId, cita._id));
  assert.deepEqual(r.followUps, []);
  assert.equal(r.aproximado, false);
});

/**
 * EL RESPALDO, para lo que no lleva sello: en producción una de cada tres citas
 * atendidas no lo tiene (se cerraron con el botón de finalizar sin escribir, o
 * son anteriores a los turnos). Se busca por el día Y por quién atendió, y se
 * marca como aproximado para que la pantalla lo diga.
 */
test('R5) sin sello, cae al día + quien atendió, y avisa de que es aproximado', async () => {
  const { clinicId, userId, patient, docA, docB, cita } = await seed();

  // Consulta de DocA escrita sin pasar por la cita (como las viejas).
  ok(await escribir(clinicId, docA._id, patient._id, { motivoConsulta: 'Lo de ese día' }));
  // Y otra de DocB el mismo día, que NO es de esta cita.
  ok(await escribir(clinicId, docB._id, patient._id, { motivoConsulta: 'De otro doctor' }, 'ginecologia'));

  // La cita, a la antigua: doctor por el espejo y sin turnos.
  await Appointment.updateOne(
    { _id: cita._id },
    { $set: { doctor: docA._id, status: 'completada', turns: [] } }
  );

  const r = ok(await consultaDe(clinicId, userId, cita._id));
  assert.equal(r.aproximado, true, 'se dice que es del día, no de la cita');
  assert.deepEqual(
    r.followUps.map((f) => f.motivoConsulta),
    ['Lo de ese día'],
    'la del otro doctor NO se cuela'
  );
});

test('R6) el respaldo no se salta de día', async () => {
  const { clinicId, userId, patient, docA, cita } = await seed();
  ok(await escribir(clinicId, docA._id, patient._id, {
    motivoConsulta: 'De la semana pasada', fecha: H.docDate(-7),
  }));
  await Appointment.updateOne({ _id: cita._id }, { $set: { doctor: docA._id, status: 'completada', turns: [] } });

  const r = ok(await consultaDe(clinicId, userId, cita._id));
  assert.deepEqual(r.followUps, [], 'una consulta de otro día no es la de esta cita');
});

/**
 * La consulta del terapeuta es privada, y esta es una puerta nueva a los
 * seguimientos: si no se recorta aquí, se recortó en siete sitios y se abrió en
 * el octavo.
 */
test('R7) la consulta del terapeuta no sale por esta puerta', async () => {
  const { clinicId, userId, patient, cita } = await seed();
  const tera = await User.create({
    name: 'Tera', email: 'tera@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'terapeuta' }],
  });
  ok(await asignar(clinicId, userId, cita._id, [tera._id]));
  ok(await escribir(clinicId, tera._id, patient._id, {
    motivoConsulta: 'Lo que se habló en sesión',
    appointmentId: String(cita._id),
  }, 'terapeuta'));

  const paraCaja = ok(await consultaDe(clinicId, userId, cita._id, 'cajero'));
  assert.equal(paraCaja.followUps.length, 1, 'la atención existió y eso sí se dice');
  assert.equal(paraCaja.followUps[0].redacted, true);
  assert.notEqual(paraCaja.followUps[0].motivoConsulta, 'Lo que se habló en sesión');

  const paraEl = ok(await consultaDe(clinicId, userId, cita._id, 'terapeuta'));
  assert.equal(paraEl.followUps[0].motivoConsulta, 'Lo que se habló en sesión');
});

test('R8) una cita que no existe da 404', async () => {
  const { clinicId, userId } = await seed();
  const r = await consultaDe(clinicId, userId, '6a0d91956966a5f0c17ed940');
  assert.equal(r.statusCode, 404);
});
