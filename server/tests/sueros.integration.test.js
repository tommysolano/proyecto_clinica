/**
 * SUEROS: recetar por cantidad y administrar por dosis.
 *
 * El doctor receta, por ejemplo, 7 sueros; enfermería los va poniendo en días
 * distintos. Lo que vigilan estos tests es lo que se rompe en silencio y acaba
 * en el paciente:
 *
 *  1. Que no se pueda poner MÁS de lo recetado. Un contador libre convierte
 *     "7 sueros" en una sugerencia.
 *  2. Que quede constancia de QUIÉN puso cada uno, con su nombre guardado: si
 *     esa persona se va de la clínica, el registro clínico no puede quedarse sin
 *     responsable.
 *  3. Que ENFERMERÍA solo reciba la receta. Esconder el resto en la pantalla no
 *     es esconderlo: la respuesta del servidor se lee entera desde el navegador.
 *  4. Que un enfermero NO pueda escribir un seguimiento.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const doctor = await User.create({
    name: 'Dra. Salas', email: 'doc@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const enfermero = await User.create({
    name: 'Karla', email: 'enf@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  return { clinicId, userId, patient, doctor, enfermero };
}

/** Deja una consulta con un suero de `cantidad` dosis y devuelve sus ids. */
async function recetarSuero(clinicId, doctor, patient, cantidad = 3) {
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Deshidratación',
      recetaItems: [
        { name: 'Suero fisiológico', quantity: cantidad, isSerum: true, dose: '500 ml' },
        { name: 'Paracetamol', quantity: 10 },
      ],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = record.followUps[record.followUps.length - 1];
  const suero = fu.recetaItems.find((it) => it.isSerum);
  assert.ok(suero, 'el ítem quedó marcado como suero');
  return { followUpId: String(fu._id), itemId: String(suero._id) };
}

const administrar = (clinicId, quien, role, patient, followUpId, itemId, body = {}) =>
  H.runController(
    ctrl.administerSerum,
    H.mockReq(clinicId, quien._id, body, {
      role,
      params: { patientId: String(patient._id), followUpId, itemId },
    }),
  );

// ───────────────────── recetar y administrar ─────────────────────

test('el enfermero administra y la cuenta va bajando', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 3);

  for (let i = 1; i <= 3; i += 1) {
    const r = await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId);
    assert.equal(r.statusCode < 400, true, `dosis ${i}: ${JSON.stringify(r.payload)}`);
  }

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suero = record.followUps[0].recetaItems.find((it) => it.isSerum);
  assert.equal(suero.administrations.length, 3);
  // Con nombre guardado: el registro no puede quedarse sin responsable el día
  // que esa persona salga de la clínica.
  assert.equal(suero.administrations[0].byName, 'Karla');
  assert.ok(suero.administrations[0].at);
});

test('no se puede administrar más de lo que recetó el doctor', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 2);

  await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId);
  await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId);
  const tercera = await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId);

  assert.equal(tercera.statusCode, 409, 'para más dosis hace falta receta nueva');
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suero = record.followUps[0].recetaItems.find((it) => it.isSerum);
  assert.equal(suero.administrations.length, 2, 'y no se guardó de todos modos');
});

test('un ítem que NO es suero no se puede administrar', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await recetarSuero(clinicId, doctor, patient, 2);

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = record.followUps[0];
  const paracetamol = fu.recetaItems.find((it) => !it.isSerum);

  const r = await administrar(
    clinicId, enfermero, 'enfermero', patient, String(fu._id), String(paracetamol._id),
  );
  assert.equal(r.statusCode, 400);
});

test('deshacer quita la última, y solo puede quien la puso (o un admin)', async () => {
  const { clinicId, userId, patient, doctor, enfermero } = await seed();
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 3);
  await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId);

  const params = { params: { patientId: String(patient._id), followUpId, itemId } };

  // Otro enfermero no deshace lo que registró un compañero.
  const otro = await User.create({
    name: 'Otro', email: 'otro@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  const ajeno = await H.runController(
    ctrl.undoSerumAdministration,
    H.mockReq(clinicId, otro._id, {}, { role: 'enfermero', ...params }),
  );
  assert.equal(ajeno.statusCode, 403);

  // El administrador sí.
  const admin = await H.runController(
    ctrl.undoSerumAdministration,
    H.mockReq(clinicId, userId, {}, { role: 'admin', ...params }),
  );
  assert.equal(admin.statusCode < 400, true, JSON.stringify(admin.payload));

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suero = record.followUps[0].recetaItems.find((it) => it.isSerum);
  assert.equal(suero.administrations.length, 0);
});

// ───────────────────── qué ve enfermería ─────────────────────

test('al enfermero el servidor le manda SOLO la receta', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Motivo reservado',
      enfermedadActual: 'Cuadro clínico detallado',
      planTratamiento: 'Plan del médico',
      diagnosticos: [{ descripcion: 'Gastroenteritis', cie: 'A09' }],
      recetaItems: [{ name: 'Suero fisiológico', quantity: 5, isSerum: true }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  const r = await H.runController(
    ctrl.getOrCreateByPatient,
    H.mockReq(clinicId, enfermero._id, {}, { role: 'enfermero', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const fu = r.payload.followUps[0];
  assert.equal(fu.recetaItems.length, 1, 'la receta sí');
  assert.equal(fu.recetaItems[0].name, 'Suero fisiológico');
  // Y nada de la consulta: esconderlo solo en la pantalla no es esconderlo.
  assert.equal(fu.descripcion, undefined);
  assert.equal(fu.enfermedadActual, undefined);
  assert.equal(fu.planTratamiento, undefined);
  assert.equal(fu.diagnosticos, undefined);
});

test('el doctor sigue recibiendo la consulta entera', async () => {
  const { clinicId, patient, doctor } = await seed();
  await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Motivo visible',
      planTratamiento: 'Plan del médico',
      recetaItems: [{ name: 'Suero', quantity: 2, isSerum: true }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  const r = await H.runController(
    ctrl.getOrCreateByPatient,
    H.mockReq(clinicId, doctor._id, {}, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  const fu = r.payload.followUps[0];
  assert.equal(fu.descripcion, 'Motivo visible');
  assert.equal(fu.planTratamiento, 'Plan del médico');
});

test('las derivaciones no le llegan a enfermería', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Consulta',
      recetaItems: [{ name: 'Suero', quantity: 1, isSerum: true }],
      derivacionItems: [{ name: 'Fisioterapia', quantity: 4 }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  const r = await H.runController(
    ctrl.getOrCreateByPatient,
    H.mockReq(clinicId, enfermero._id, {}, { role: 'enfermero', params: { patientId: String(patient._id) } }),
  );
  const items = r.payload.followUps[0].recetaItems;
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Suero', 'la derivación se queda fuera: no es algo que se aplique');
});

test('marcar suero en una DERIVACIÓN no cuela', async () => {
  const { clinicId, patient, doctor } = await seed();
  await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Consulta',
      derivacionItems: [{ name: 'Fisioterapia', quantity: 4, isSerum: true }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const item = record.followUps[0].recetaItems[0];
  assert.equal(item.isService, true);
  assert.equal(item.isSerum, false, 'un servicio se agenda, no se administra por dosis');
});
