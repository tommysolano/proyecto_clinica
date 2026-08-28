/**
 * QUÉ SALE EN EL PAPEL: la receta en PDF y la hoja MSP HCU-form.002.
 *
 * Los dos PDF los arma este controlador con plantillas de texto, y hasta ahora
 * nadie los miraba en los tests: un `${}` mal puesto salía en producción, en la
 * hoja que se lleva el paciente. Aquí se sustituye puppeteer por un doble que
 * captura el HTML, de modo que se comprueba el CONTENIDO sin arrancar un
 * navegador (lento y con dependencias del sistema).
 *
 * Lo que se vigila:
 *
 *  1. Que la preparación del suero (cloruro + ampollas) salga impresa: es lo que
 *     enfermería prepara y lo que el paciente enseña si va a otra parte.
 *  2. Que salgan las recomendaciones no farmacológicas.
 *  3. Que la hoja MSP imprima quirúrgicos, medicación, alergias y hábitos.
 *  4. Que el texto del usuario siga ESCAPADO: el médico teclea a mano y un
 *     "Suero A&D" o un "<400 mg>" se comería el navegador al imprimir.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');

// ── Doble de puppeteer: guarda el HTML que se le pasa y devuelve un PDF falso ──
// Se instala en la caché de módulos ANTES de que el controlador haga su
// `require('puppeteer')` perezoso, así que basta con hacerlo una vez aquí.
let htmlCapturado = '';
const rutaPuppeteer = require.resolve('puppeteer');
require.cache[rutaPuppeteer] = {
  id: rutaPuppeteer,
  filename: rutaPuppeteer,
  loaded: true,
  exports: {
    launch: async () => ({
      newPage: async () => ({
        setContent: async (html) => { htmlCapturado = html; },
        pdf: async () => Buffer.from('%PDF-falso'),
      }),
      close: async () => {},
    }),
  },
};

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); htmlCapturado = ''; });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Shiluv', nombreComercial: 'Shiluv' });
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  const doctor = await User.create({
    name: 'Dra. Salas', email: 'doc@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  return { clinicId, userId, patient, doctor };
}

/** Ficha + un seguimiento con suero compuesto, recomendaciones y antecedentes. */
async function fichaCompleta(clinicId, userId, patient, doctor, extra = {}) {
  await ClinicalRecord.create({
    clinic: clinicId,
    patient: patient._id,
    createdBy: userId,
    edad: 34,
    antecedentesQuirurgicos: 'Apendicectomía (2018)',
    antecedentesMedicamentos: 'Losartán 50 mg c/24 h',
    alergias: 'Penicilina: urticaria',
    habitos: [{ key: 'tabaco', marked: true, detail: '10 al día' }],
    habitosDetalle: 'Sedentaria',
    ...extra.record,
  });
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Anemia',
      planTratamiento: 'Sueroterapia semanal',
      recomendacionesNoFarmacologicas: 'Dieta rica en hierro. Caminar 30 min al día.',
      recetaItems: [
        {
          name: 'Sueroterapia', quantity: 2, isSerum: true,
          instructions: 'Pasar en 45 minutos',
          serumBase: { name: 'Cloruro', volumeMl: 500 },
          serumComponents: [
            { code: 'AAPL01', name: 'APIMEL 2ML AMP', quantity: 1 },
            { code: 'PTHIERR01', name: 'HIERRO 2ML AMP', quantity: 2 },
          ],
        },
        { name: 'Paracetamol 500 mg', quantity: 10, dose: '1 tableta', instructions: 'Después de comer' },
      ],
      ...extra.followUp,
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  return String(rec.followUps[0]._id);
}

/**
 * Los endpoints de PDF responden con `res.end(buffer)`, no con `res.json`, así
 * que no sirve `H.runController` (espera a que el controlador llame a json/send).
 * Este `res` mínimo cubre lo que usan: status, setHeader, end y el json del
 * camino de error.
 */
const imprimir = async (fn, clinicId, quien, patient, followUpId) => {
  const state = { statusCode: 200, payload: undefined, headers: {} };
  const res = {
    status: (c) => { state.statusCode = c; return res; },
    json: (p) => { state.payload = p; return res; },
    setHeader: (n, v) => { state.headers[n] = v; return res; },
    end: (buf) => { state.payload = buf; return res; },
  };
  await fn(
    H.mockReq(clinicId, quien._id, {}, {
      role: 'doctor', params: { patientId: String(patient._id), followUpId },
    }),
    res,
  );
  return state;
};

// ───────────────────── receta en PDF ─────────────────────

test('la receta en PDF imprime la preparación del suero', async () => {
  const { clinicId, userId, patient, doctor } = await seed();
  const followUpId = await fichaCompleta(clinicId, userId, patient, doctor);

  const r = await imprimir(ctrl.printFollowUp, clinicId, doctor, patient, followUpId);
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  assert.match(htmlCapturado, /Preparación del suero/);
  assert.match(htmlCapturado, /Cloruro 500 ml/);
  assert.match(htmlCapturado, /APIMEL 2ML AMP ×1/);
  assert.match(htmlCapturado, /HIERRO 2ML AMP ×2/);
  // El medicamento normal no arrastra ninguna preparación.
  assert.equal((htmlCapturado.match(/Preparación del suero/g) || []).length, 1);
});

test('la receta NO imprime la consulta: ni signos vitales ni motivo ni observaciones', async () => {
  // Es el papel que se lleva el paciente. La anamnesis, los signos vitales y los
  // hallazgos de la especialidad son historia clínica y salen en la hoja MSP,
  // no en la mano del paciente ni de quien la lea por el camino.
  const { clinicId, userId, patient, doctor } = await seed();
  const followUpId = await fichaCompleta(clinicId, userId, patient, doctor, {
    followUp: {
      descripcion: 'Motivo reservado',
      observaciones: 'Nota interna del médico',
      estudioSintomas: 'Sospecha de algo',
      vitalSigns: { bloodPressure: '120/80', heartRate: 72, weight: 68, glucose: 95 },
      cardiologia: { alergias: 'Ninguna', medicacionActual: 'Losartán' },
    },
  });
  await imprimir(ctrl.printFollowUp, clinicId, doctor, patient, followUpId);

  assert.doesNotMatch(htmlCapturado, /Signos vitales/, 'los signos vitales no van en la receta');
  assert.doesNotMatch(htmlCapturado, /120\/80/);
  assert.doesNotMatch(htmlCapturado, /Motivo de consulta/);
  assert.doesNotMatch(htmlCapturado, /Motivo reservado/);
  assert.doesNotMatch(htmlCapturado, /Observaciones/);
  assert.doesNotMatch(htmlCapturado, /Nota interna del médico/);
  assert.doesNotMatch(htmlCapturado, /Estudio o síntomas/);

  // Y sí sigue imprimiendo lo que el paciente tiene que hacer.
  assert.match(htmlCapturado, /Receta médica/);
  assert.match(htmlCapturado, /Paracetamol 500 mg/);
  assert.match(htmlCapturado, /Preparación del suero/);
  assert.match(htmlCapturado, /Recomendaciones no farmacológicas/);
});

test('la receta óptica SÍ se imprime: para el óptico la graduación es la receta', async () => {
  const { clinicId, userId, patient, doctor } = await seed();
  const followUpId = await fichaCompleta(clinicId, userId, patient, doctor, {
    followUp: {
      opticaRx: { od: { sph: '-1.25', cyl: '-0.50', ax: '90' }, oi: { sph: '-1.00' } },
    },
  });
  await imprimir(ctrl.printFollowUp, clinicId, doctor, patient, followUpId);
  assert.match(htmlCapturado, /Receta óptica \(RX\)/);
  assert.match(htmlCapturado, /-1\.25/);
});

test('la receta en PDF imprime las recomendaciones no farmacológicas', async () => {
  const { clinicId, userId, patient, doctor } = await seed();
  const followUpId = await fichaCompleta(clinicId, userId, patient, doctor);
  await imprimir(ctrl.printFollowUp, clinicId, doctor, patient, followUpId);

  assert.match(htmlCapturado, /Recomendaciones no farmacológicas/);
  assert.match(htmlCapturado, /Dieta rica en hierro/);
});

test('el nombre de una ampolla con & o < sale escapado', async () => {
  const { clinicId, userId, patient, doctor } = await seed();
  const followUpId = await fichaCompleta(clinicId, userId, patient, doctor, {
    followUp: {
      recetaItems: [{
        name: 'Suero A&D', quantity: 1, isSerum: true,
        serumBase: { volumeMl: 250 },
        serumComponents: [{ name: 'Vitamina <B12>', quantity: 1 }],
      }],
    },
  });
  await imprimir(ctrl.printFollowUp, clinicId, doctor, patient, followUpId);

  assert.match(htmlCapturado, /Vitamina &lt;B12&gt; ×1/, 'la ampolla escrita a mano va escapada');
  assert.doesNotMatch(htmlCapturado, /Vitamina <B12>/, 'sin escapar el navegador se la comería');
});

// ───────────────────── hoja MSP HCU-form.002 ─────────────────────

test('la hoja MSP imprime quirúrgicos, medicación, alergias y hábitos', async () => {
  const { clinicId, userId, patient, doctor } = await seed();
  const followUpId = await fichaCompleta(clinicId, userId, patient, doctor);

  const r = await imprimir(ctrl.printMspForm, clinicId, doctor, patient, followUpId);
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  assert.match(htmlCapturado, /Quirúrgicos:<\/b> Apendicectomía \(2018\)/);
  assert.match(htmlCapturado, /Medicación habitual:<\/b> Losartán 50 mg c\/24 h/);
  assert.match(htmlCapturado, /Alergias:<\/b> Penicilina: urticaria/);
  assert.match(htmlCapturado, /HÁBITOS/);
  assert.match(htmlCapturado, /10 al día/);
  assert.match(htmlCapturado, /Detalle:<\/b> Sedentaria/);
});

test('la hoja MSP imprime el plan, las recomendaciones y la preparación del suero', async () => {
  const { clinicId, userId, patient, doctor } = await seed();
  const followUpId = await fichaCompleta(clinicId, userId, patient, doctor);
  await imprimir(ctrl.printMspForm, clinicId, doctor, patient, followUpId);

  assert.match(htmlCapturado, /J\. PLAN DE TRATAMIENTO/);
  assert.match(htmlCapturado, /Sueroterapia semanal/);
  assert.match(htmlCapturado, /RECOMENDACIONES NO FARMACOLÓGICAS/);
  assert.match(htmlCapturado, /Dieta rica en hierro/);
  assert.match(htmlCapturado, /Preparación del suero:<\/b> Cloruro 500 ml · APIMEL 2ML AMP ×1 · HIERRO 2ML AMP ×2/);
});

test('una ficha sin hábitos no imprime la sección vacía', async () => {
  const { clinicId, userId, patient, doctor } = await seed();
  const followUpId = await fichaCompleta(clinicId, userId, patient, doctor, {
    record: { habitos: [], habitosDetalle: '', antecedentesQuirurgicos: '', antecedentesMedicamentos: '', alergias: '' },
  });
  await imprimir(ctrl.printMspForm, clinicId, doctor, patient, followUpId);

  // Se busca la BARRA de sección, no la palabra: el comentario `<!-- HÁBITOS -->`
  // de la plantilla está siempre y haría pasar el test por casualidad.
  assert.doesNotMatch(htmlCapturado, /class="bar">HÁBITOS/, 'sin datos no se imprime una rejilla en blanco');
  assert.doesNotMatch(htmlCapturado, /Quirúrgicos:/);
});
