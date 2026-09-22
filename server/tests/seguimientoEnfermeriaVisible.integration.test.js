/**
 * EL CASO REAL QUE MOTIVÓ ESTO (Danny Almagro / kike, 11-sep-2026).
 *
 * Mostrador receta un suero → la ficha queda con la receta y la cita de
 * enfermería en la agenda. Pero kike, el enfermero, abría la pestaña de
 * SEGUIMIENTOS por su cita y no veía NADA: ni el suero, ni un parte.
 *
 * Dos causas, las dos aquí:
 *  1. La cita que reclamó kike era una «atención inmediata» sin turnos útiles
 *     (o la receta se sembró en la OTRA cita del mismo día). La puerta
 *     `by-appointment` solo devuelve seguimientos SELlADOS en la cita, y sin
 *     sello no había nada — y a enfermería ni siquiera le llegaba el respaldo
 *     por día, porque estaba excluido a propósito.
 *  2. El parte automático de «Terminar» (`nurseComplete`) escribía el
 *     seguimiento en la ficha pero NO sellaba su `_id` en `turns[].followUp`:
     *  el parte existía y aun así la pestaña seguía en blanco.
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

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Danny', lastName: 'Almagro Reyes', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const kike = await User.create({
    name: 'Kike', email: 'kike@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  const cajera = await User.create({
    name: 'Nathaly', email: 'caja@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'cajero' }],
  });

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '12:20', status: 'pendiente',
  });
  return { clinicId, patient, kike, cajera, cita };
}

const params = (id) => ({ params: { id: String(id) } });
const comoEnfermero = (clinicId, userId, id, body = {}) =>
  H.mockReq(clinicId, userId, body, { role: 'enfermero', ...params(id) });

/** La pestaña de seguimientos tal como la lee la ficha del enfermero. */
const seguimientosDe = (clinicId, userId, citaId) =>
  H.runController(
    records.getFollowUpsByAppointment,
    H.mockReq(clinicId, userId, {}, { role: 'enfermero', params: { appointmentId: String(citaId) } }),
  );

test('la cita sin turnos que reclamó kike muestra el suero recetado ese día', async () => {
  const { clinicId, patient, kike, cajera, cita } = await seed();

  // Mostrador receta el suero en la ficha (queda en la historia del paciente).
  const r = await H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, cajera._id, {
      motivoConsulta: 'Suero indicado al asignar la atención (SUEROTERAPIA)',
      recetaItems: [{
        name: 'SUEROTERAPIA', quantity: 1, isSerum: true,
        serumBase: { name: 'Cloruro', volumeMl: 100 },
        serumComponents: [{ name: 'BERBERIS 2ML AMP', quantity: 1 }],
      }],
    }, { role: 'cajero', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  // La cita de kike, como la real: SIN turnos. La reclama (queda a su nombre).
  const claim = await H.runController(appt.nurseClaim, comoEnfermero(clinicId, kike._id, cita._id));
  assert.equal(claim.statusCode < 400, true, JSON.stringify(claim.payload));

  // ANTES: seguimientos vacíos, sin nada que explicara por qué.
  const vista = await seguimientosDe(clinicId, kike._id, cita._id);
  assert.equal(vista.statusCode, 200, JSON.stringify(vista.payload));
  // SEP-2026 (vista recortada para enfermería): el motivo queda redactado, pero
  // la línea del suero —que es lo que tiene que aplicar— se ve entera.
  assert.ok(
    vista.payload.followUps.some((f) =>
      (f.recetaItems || []).some((it) => /SUEROTERAPIA/i.test(it.name || ''))
    ),
    'el suero recetado ese día tiene que verse desde la cita del enfermero'
  );
  assert.equal(vista.payload.aproximado, true, 'y la pantalla dice que viene por el día');
});

test('el parte de «Terminar» queda sellado en el turno y se ve por la cita', async () => {
  const { clinicId, userId, patient, kike, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria', serviceName: 'Sueroterapia' }],
  }, params(cita._id)));

  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, kike._id, cita._id));
  const fin = await H.runController(appt.nurseComplete, comoEnfermero(clinicId, kike._id, cita._id));
  assert.equal(fin.statusCode < 400, true, JSON.stringify(fin.payload));

  // El sello quedó en el turno...
  const a = await Appointment.findById(cita._id).lean();
  const turno = a.turns.find((t) => t.kind === 'enfermeria');
  assert.ok(turno.followUp, 'el turno apunta a su parte');
  // ...y la ficha del enfermero lo muestra (esto es lo que estaba en blanco).
  const vista = await seguimientosDe(clinicId, kike._id, cita._id);
  assert.ok(
    vista.payload.followUps.some((f) => String(f._id) === String(turno.followUp)),
    'el parte automático se ve en seguimientos por la cita'
  );
  // La receta sigue siendo la única verdad de la ficha.
  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.ok(rec.followUps.some((f) => f.kind === 'enfermeria'));
});
