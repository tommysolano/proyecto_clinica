/**
 * FICHA: antecedentes quirúrgicos, medicación habitual, alergias y hábitos.
 * SEGUIMIENTO: recomendaciones no farmacológicas.
 *
 * La hoja MSP amontona cirugías, medicación y alergias en un único renglón de
 * "datos relevantes" al pie de los antecedentes. En la consulta son tres
 * preguntas distintas, y escritas en el mismo párrafo se pierden: la alergia a
 * un fármaco es lo primero que hay que mirar antes de recetar y estaba a la
 * altura de una nota suelta.
 *
 * Lo que vigilan estos tests:
 *
 *  1. Que los campos nuevos se guarden y se devuelvan (no que existan en el
 *     esquema: que sobrevivan al `allowed` del controlador, que es donde se
 *     caen los campos que nadie añadió a la lista).
 *  2. Que los hábitos solo acepten las casillas del catálogo y no dejen filas
 *     vacías por ficha.
 *  3. Que guardar la ficha NO borre lo que ya había (el formulario manda solo
 *     una parte según quién lo abra).
 *  4. Que las recomendaciones no farmacológicas viajen en el seguimiento.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');
const { HABITOS_CATEGORIAS } = require('../constants/mspCatalogs');

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

const guardarFicha = (clinicId, quien, role, patient, body) =>
  H.runController(
    ctrl.updateByPatient,
    H.mockReq(clinicId, quien._id, body, { role, params: { patientId: String(patient._id) } }),
  );

// ───────────────────── los apartados nuevos ─────────────────────

test('se guardan quirúrgicos, medicación habitual, alergias y hábitos', async () => {
  const { clinicId, patient, doctor } = await seed();

  const r = await guardarFicha(clinicId, doctor, 'doctor', patient, {
    antecedentesQuirurgicos: 'Apendicectomía (2018), cesárea (2021)',
    antecedentesMedicamentos: 'Losartán 50 mg cada 24 h desde 2023',
    alergias: 'Penicilina: urticaria. Mariscos.',
    habitos: [
      { key: 'tabaco', marked: true, detail: '10 al día desde los 20' },
      { key: 'alcohol', marked: true, detail: 'Social, fines de semana' },
      { key: 'drogas', marked: false, detail: '' },
    ],
    habitosDetalle: 'Camina 30 minutos tres veces por semana',
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.equal(rec.antecedentesQuirurgicos, 'Apendicectomía (2018), cesárea (2021)');
  assert.equal(rec.antecedentesMedicamentos, 'Losartán 50 mg cada 24 h desde 2023');
  assert.equal(rec.alergias, 'Penicilina: urticaria. Mariscos.');
  assert.equal(rec.habitosDetalle, 'Camina 30 minutos tres veces por semana');

  // La casilla sin marcar y sin detalle no se guarda: son 9 hábitos y guardarlos
  // todos dejaría 7 filas en blanco en cada ficha.
  assert.deepEqual(
    rec.habitos.map((h) => [h.key, h.marked, h.detail]),
    [['tabaco', true, '10 al día desde los 20'], ['alcohol', true, 'Social, fines de semana']],
  );
});

test('un hábito que no está en el catálogo no entra', async () => {
  const { clinicId, patient, doctor } = await seed();
  await guardarFicha(clinicId, doctor, 'doctor', patient, {
    habitos: [
      { key: 'tabaco', marked: true, detail: 'Medio paquete' },
      { key: 'loQueSea', marked: true, detail: 'Inventado' },
    ],
  });
  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.deepEqual(rec.habitos.map((h) => h.key), ['tabaco']);
});

test('el catálogo de hábitos cubre lo que se pidió: fuma, bebe, drogas', async () => {
  const keys = HABITOS_CATEGORIAS.map((h) => h.key);
  for (const k of ['tabaco', 'alcohol', 'drogas']) {
    assert.ok(keys.includes(k), `falta el hábito ${k}`);
  }
});

test('guardar solo un campo no borra el resto de la ficha', async () => {
  const { clinicId, patient, doctor } = await seed();
  await guardarFicha(clinicId, doctor, 'doctor', patient, {
    alergias: 'Penicilina',
    antecedentesQuirurgicos: 'Apendicectomía',
    habitos: [{ key: 'tabaco', marked: true, detail: '10 al día' }],
  });

  // Segundo guardado que solo toca las alergias: lo demás no viaja en el cuerpo.
  await guardarFicha(clinicId, doctor, 'doctor', patient, { alergias: 'Penicilina y AINEs' });

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.equal(rec.alergias, 'Penicilina y AINEs', 'se actualiza lo que se manda');
  assert.equal(rec.antecedentesQuirurgicos, 'Apendicectomía', 'y no se pierde lo que no');
  assert.equal(rec.habitos.length, 1, 'los hábitos siguen ahí');
});

test('a ENFERMERÍA sí le llegan los antecedentes y las alergias', async () => {
  // Es el punto del cambio: quien canaliza una vía y mete tres ampollas tiene
  // que ver a qué es alérgico el paciente y qué toma ya. Si este test se vuelve
  // a poner del revés, se está tapando otra vez lo único que evita la reacción.
  const { clinicId, patient, doctor, enfermero } = await seed();
  await guardarFicha(clinicId, doctor, 'doctor', patient, {
    alergias: 'Penicilina',
    antecedentesQuirurgicos: 'Apendicectomía',
    antecedentesMedicamentos: 'Losartán',
    habitos: [{ key: 'tabaco', marked: true, detail: '10 al día' }],
    habitosDetalle: 'Sedentaria',
  });

  const r = await H.runController(
    ctrl.getOrCreateByPatient,
    H.mockReq(clinicId, enfermero._id, {}, {
      role: 'enfermero', params: { patientId: String(patient._id) },
    }),
  );
  assert.equal(r.payload.alergias, 'Penicilina');
  assert.equal(r.payload.antecedentesQuirurgicos, 'Apendicectomía');
  assert.equal(r.payload.antecedentesMedicamentos, 'Losartán');
  assert.equal(r.payload.habitosDetalle, 'Sedentaria');
  assert.equal(r.payload.habitos[0].detail, '10 al día');
});

// ───────────────────── recomendaciones no farmacológicas ─────────────────────

test('las recomendaciones no farmacológicas se guardan en el seguimiento', async () => {
  const { clinicId, patient, doctor } = await seed();
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Control de hipertensión',
      planTratamiento: 'Losartán 50 mg cada 24 h. Control en 30 días.',
      recomendacionesNoFarmacologicas: 'Dieta hiposódica. Caminar 30 min al día. Dormir 7 h.',
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = rec.followUps[0];
  assert.equal(fu.planTratamiento, 'Losartán 50 mg cada 24 h. Control en 30 días.');
  assert.equal(
    fu.recomendacionesNoFarmacologicas,
    'Dieta hiposódica. Caminar 30 min al día. Dormir 7 h.',
    'es un campo aparte del plan, no se mezcla con él',
  );
});

test('sin recomendaciones el seguimiento se guarda igual', async () => {
  const { clinicId, patient, doctor } = await seed();
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Control',
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201);
  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.equal(rec.followUps[0].recomendacionesNoFarmacologicas, '');
});
