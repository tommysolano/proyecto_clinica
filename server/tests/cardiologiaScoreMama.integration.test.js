/**
 * CARDIOLOGÍA (rol nuevo) y SCORE MAMÁ (ginecología).
 *
 * Lo que vigilan:
 *  1. 'cardiologia' es una especialidad de doctor a todos los efectos: si no
 *     entra en la expansión, da 403 en todas las rutas que declaran 'doctor'.
 *  2. Los antecedentes cardiológicos son de TRES estados. Un booleano no vale:
 *     "consta que el paciente NO es hipertenso" y "no se preguntó" son cosas
 *     distintas y el saneador tiene que distinguirlas.
 *  3. El Score MAMÁ se RECALCULA en el servidor. Es el puntaje que decide si se
 *     activa la clave obstétrica: no puede depender de lo que mande el navegador.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const clinicalRecords = require('../controllers/clinicalRecordController');
const { DOCTOR_LIKE_ROLES, DOCTOR_SPECIALTY_ROLES, isDoctorRole, VALID_ROLES } = require('../constants/roles');
const { calcularScoreMama } = require('../constants/scoreMama');
const { cardiologiaHtml } = require('../utils/specialtyFollowUpPrint');

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

// ───────────────────────── el rol ─────────────────────────

test('cardiologia es un doctor para todo el backend', () => {
  assert.ok(DOCTOR_LIKE_ROLES.includes('cardiologia'));
  assert.ok(DOCTOR_SPECIALTY_ROLES.includes('cardiologia'), 'requireRole(doctor) tiene que expandir a ella');
  assert.ok(isDoctorRole('cardiologia'));
  assert.ok(VALID_ROLES.includes('cardiologia'), 'y se le puede asignar a un usuario');
});

// ───────────────────── ficha cardiológica ─────────────────────

test('la ficha cardiológica guarda sus secciones', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  const r = await post(clinicId, userId, p._id, {
    descripcion: 'Dolor torácico',
    cardiologia: {
      antecedentes: [
        { key: 'hta', value: true },
        { key: 'dm', value: false },
        { key: 'tabaquismo', value: true },
      ],
      antecedentesOtros: 'Padre con IAM a los 50',
      alergias: 'Penicilina',
      medicacionActual: 'Losartán 50 mg c/24 h',
      electrocardiograma: { ritmo: 'Sinusal', fc: 72, hallazgos: 'Sin alteraciones agudas' },
      estudios: { ecocardiograma: 'FEVI 60%', holter: '', mapa: '', ergometria: '', laboratorio: 'LDL 160' },
      plan: { estudiosSolicitados: 'Prueba de esfuerzo', proximoControl: 'En 3 meses' },
    },
  }, 'cardiologia');

  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const fu = (r.payload.followUps || []).slice(-1)[0];
  const c = fu.cardiologia;

  assert.equal(c.antecedentes.length, 3);
  assert.equal(c.antecedentes.find((a) => a.key === 'hta').value, true);
  // Que conste que NO es diabético es un dato clínico: no se descarta.
  assert.equal(c.antecedentes.find((a) => a.key === 'dm').value, false);
  assert.equal(c.alergias, 'Penicilina');
  assert.equal(c.electrocardiograma.fc, 72);
  assert.equal(c.estudios.ecocardiograma, 'FEVI 60%');
  assert.equal(c.plan.proximoControl, 'En 3 meses');
});

test('un antecedente sin responder NO se guarda como "no"', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  const r = await post(clinicId, userId, p._id, {
    descripcion: 'Control',
    cardiologia: {
      antecedentes: [
        { key: 'hta', value: true },
        { key: 'dm', value: null },          // sin consignar
        { key: 'erc' },                       // sin valor
        { key: 'inventado', value: true },    // fuera de catálogo
      ],
    },
  }, 'cardiologia');

  const c = (r.payload.followUps || []).slice(-1)[0].cardiologia;
  assert.equal(c.antecedentes.length, 1, 'solo el que trae un booleano de verdad');
  assert.equal(c.antecedentes[0].key, 'hta');
});

test('el PDF del cardiólogo imprime lo que consta y lo que se niega', () => {
  const html = cardiologiaHtml({
    antecedentes: [{ key: 'hta', value: true }, { key: 'dm', value: false }],
  });
  assert.match(html, /Ficha cardiológica/);
  assert.match(html, /Presenta:<\/b> HTA/);
  assert.match(html, /Niega:<\/b> DM/);
  // Y el PDF de un doctor general no cambia.
  assert.equal(cardiologiaHtml(null), '');
  assert.equal(cardiologiaHtml({}), '');
});

// ───────────────────────── Score MAMÁ ─────────────────────────

test('los cortes de la tabla del MSP dan el puntaje que dice la norma', () => {
  // Paciente estable.
  const normal = calcularScoreMama({
    fc: 80, sistolica: 110, diastolica: 70, fr: 18, temperatura: 36.5,
    saturacion: 98, conciencia: 'alerta', proteinuria: 'negativa',
  });
  assert.equal(normal.total, 0);

  // Preeclampsia grave: dispara la clave obstétrica.
  const grave = calcularScoreMama({
    fc: 125, sistolica: 165, diastolica: 115, fr: 32, temperatura: 38.6,
    saturacion: 84, conciencia: 'no_responde', proteinuria: 'positiva',
  });
  assert.equal(grave.puntajes.fc, 3);
  assert.equal(grave.puntajes.sistolica, 3);
  assert.equal(grave.puntajes.diastolica, 3);
  assert.equal(grave.puntajes.saturacion, 3);
  assert.equal(grave.total, 22);

  // Sin medir nada, el total es null: un 0 se leería como "paciente estable".
  assert.equal(calcularScoreMama({}).total, null);
});

test('el servidor RECALCULA el score: no se fía del total que llega', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  const r = await post(clinicId, userId, p._id, {
    descripcion: 'Control prenatal',
    ginecologia: {
      embarazoActual: true,
      controlPrenatal: {
        scoreMama: {
          fc: 125, sistolica: 165, diastolica: 115, fr: 32, temperatura: 38.6,
          saturacion: 84, conciencia: 'no_responde', proteinuria: 'positiva',
          // Un cliente desactualizado (o manipulado) manda un total tranquilizador.
          total: 0,
          puntajes: { fc: 0, sistolica: 0, diastolica: 0, fr: 0, temperatura: 0, saturacion: 0, conciencia: 0, proteinuria: 0 },
        },
        bebePosicion: 'Cefálico',
      },
    },
  }, 'ginecologia');

  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const cp = (r.payload.followUps || []).slice(-1)[0].ginecologia.controlPrenatal;
  assert.equal(cp.scoreMama.total, 22, 'manda el cálculo del servidor');
  assert.equal(cp.scoreMama.puntajes.fc, 3);
  assert.equal(cp.bebePosicion, 'Cefálico');
});

test('una opción de conciencia inventada no puntúa', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await seedPaciente(clinicId, userId);

  const r = await post(clinicId, userId, p._id, {
    descripcion: 'Control',
    ginecologia: {
      controlPrenatal: { scoreMama: { fc: 80, conciencia: 'flotando', proteinuria: 'quizas' } },
    },
  }, 'ginecologia');

  const sm = (r.payload.followUps || []).slice(-1)[0].ginecologia.controlPrenatal.scoreMama;
  assert.equal(sm.conciencia, '');
  assert.equal(sm.proteinuria, '');
  assert.equal(sm.puntajes.conciencia, null);
  assert.equal(sm.total, 0, 'solo cuenta la FC, que está en rango');
});
