/**
 * INDICACIONES del estudio (ecografías, laboratorio…).
 *
 * Hubo un rol 'ecografista' para esto y se retiró: quien hace ecografías es un
 * doctor más, y lo que le faltaba no era un rol sino un sitio donde subir el
 * archivo (la pestaña «Archivos»). Estos tests vigilan lo que sí importaba:
 *  1. el rol ya NO existe y no se le puede asignar a nadie;
 *  2. `indicaciones` se guarda y se devuelve. Si se perdiera, el estudio
 *     quedaría en un PDF sin una línea que lo explique;
 *  3. `indicaciones` no es de nadie en particular: se lee y se muestra como
 *     cualquier otro campo, para que quien atienda después lo vea sin abrir el
 *     archivo.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const clinicalRecords = require('../controllers/clinicalRecordController');
const {
  DOCTOR_LIKE_ROLES, DOCTOR_SPECIALTY_ROLES, isDoctorRole, VALID_ROLES,
} = require('../constants/roles');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedPaciente(clinicId, userId) {
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  return patient;
}

const post = (clinicId, userId, patientId, body, role) =>
  H.runController(
    clinicalRecords.addFollowUp,
    H.mockReq(clinicId, userId, body, { role, params: { patientId: String(patientId) } }),
  );

const ultimo = async (patientId) => {
  const rec = await ClinicalRecord.findOne({ patient: patientId });
  return rec.followUps[rec.followUps.length - 1];
};

// ───────────────────────── el rol ─────────────────────────

test('el rol ecografista ya no existe en ninguna lista', () => {
  assert.ok(!DOCTOR_LIKE_ROLES.includes('ecografista'));
  assert.ok(!DOCTOR_SPECIALTY_ROLES.includes('ecografista'));
  assert.ok(!isDoctorRole('ecografista'));
  assert.ok(
    !VALID_ROLES.includes('ecografista'),
    'y no se le puede asignar a nadie: el enum de User lo rechaza',
  );
});

// ─────────────────────── indicaciones ───────────────────────

test('un estudio se guarda con fecha, motivo e indicaciones', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  const r = await post(clinicId, userId, p._id, {
    fecha: H.docDate(),
    descripcion: 'Ecografía abdominal',
    indicaciones: 'Hígado de tamaño normal. Se recomienda control en 6 meses.',
  }, 'doctor');
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const fu = await ultimo(p._id);
  assert.equal(fu.descripcion, 'Ecografía abdominal');
  assert.equal(fu.indicaciones, 'Hígado de tamaño normal. Se recomienda control en 6 meses.');
});

test('indicaciones y evolucion son campos DISTINTOS: no se pisan', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  await post(clinicId, userId, p._id, {
    descripcion: 'Control',
    evolucion: 'Mejora respecto del control anterior',
    indicaciones: 'Repetir la ecografía en 3 meses',
  }, 'doctor');

  const fu = await ultimo(p._id);
  assert.equal(fu.evolucion, 'Mejora respecto del control anterior');
  assert.equal(fu.indicaciones, 'Repetir la ecografía en 3 meses');
});

test('lo que escribe quien hace el estudio lo lee cualquiera que abra la ficha', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  await post(clinicId, userId, p._id, {
    descripcion: 'Ecografía obstétrica',
    indicaciones: 'Feto único, vivo. Control en 4 semanas.',
  }, 'doctor');

  // La ficha se lee con el mismo endpoint para todos: si el campo llega aquí,
  // llega a la pantalla de cualquiera que pueda abrirla.
  for (const rol of ['admin', 'doctor', 'cajero', 'enfermero']) {
    const r = await H.runController(
      clinicalRecords.getOrCreateByPatient,
      H.mockReq(clinicId, userId, {}, { role: rol, params: { patientId: String(p._id) } }),
    );
    assert.equal(r.statusCode < 400, true, `${rol}: ${JSON.stringify(r.payload)}`);
    const fus = r.payload.followUps || [];
    assert.equal(
      fus[fus.length - 1].indicaciones,
      'Feto único, vivo. Control en 4 semanas.',
      `${rol} tiene que ver las indicaciones del estudio`,
    );
  }
});

test('sin indicaciones el campo queda vacío, no undefined', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  await post(clinicId, userId, p._id, { descripcion: 'Consulta general' }, 'doctor');

  const fu = await ultimo(p._id);
  assert.equal(fu.indicaciones, '', 'un seguimiento viejo o sin el campo no debe romper la lectura');
});
