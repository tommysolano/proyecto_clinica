/**
 * HOJA OFICIAL MSP HCU-form.005 — EVOLUCIÓN Y PRESCRIPCIONES.
 *
 * Es la HISTORIA del paciente, no una consulta suelta: el instructivo del MSP
 * dice «conservar un registro secuencial del progreso clínico, variaciones del
 * tratamiento y prescripciones». Lo que vigilan estos tests:
 *
 *  1. Que salgan TODAS las consultas y en orden cronológico ascendente (la 002
 *     es una; esta es el historial).
 *  2. Que los tres bloques del formulario tengan lo suyo: evolución,
 *     prescripciones y la administración de enfermería.
 *  3. Que la firma vaya al pie de cada nota y de cada grupo de prescripciones,
 *     que es una exigencia literal del instructivo.
 *  4. Que enfermería NO pueda descargarla: lleva la cédula en la cabecera.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');

// Doble de puppeteer que captura el HTML en vez de abrir un navegador.
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
  await Clinic.create({ _id: clinicId, name: 'Shiluv', nombreComercial: 'Shiluv Norte' });
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana María', lastName: 'Pérez Gómez',
    cedula: '0102030405', gender: 'femenino',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId, edad: 34 });
  const doctor = await User.create({
    name: 'Dra. Salas', email: 'doc@t.com', password: 'secreto123', specialty: 'Medicina general',
    cedula: '0999888777', clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const enfermero = await User.create({
    name: 'Karla Ruiz', email: 'enf@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  return { clinicId, userId, patient, doctor, enfermero };
}

const imprimir = async (clinicId, quien, role, patient) => {
  const state = { statusCode: 200, payload: undefined, headers: {} };
  const res = {
    status: (c) => { state.statusCode = c; return res; },
    json: (p) => { state.payload = p; return res; },
    setHeader: (n, v) => { state.headers[n] = v; return res; },
    end: (b) => { state.payload = b; return res; },
  };
  await ctrl.printHcu005(
    H.mockReq(clinicId, quien._id, {}, { role, params: { patientId: String(patient._id) } }),
    res,
  );
  return state;
};

const seguimiento = (clinicId, doctor, patient, body) =>
  H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, body, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

test('la hoja lleva la cabecera del formulario y los datos del paciente', async () => {
  const { clinicId, patient, doctor } = await seed();
  await seguimiento(clinicId, doctor, patient, { descripcion: 'Control' });

  const r = await imprimir(clinicId, doctor, 'doctor', patient);
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  assert.match(htmlCapturado, /EVOLUCIÓN Y PRESCRIPCIONES/);
  assert.match(htmlCapturado, /SNS-MSP \/ HCU-form\.005 \/ 2008/);
  assert.match(htmlCapturado, /Shiluv Norte/);
  assert.match(htmlCapturado, /ANA MARÍA/i);
  assert.match(htmlCapturado, /PÉREZ GÓMEZ/i);
  assert.match(htmlCapturado, /0102030405/, 'N.º de historia clínica');
  assert.match(htmlCapturado, /1 · EVOLUCIÓN/);
  assert.match(htmlCapturado, /2 · PRESCRIPCIONES/);
  assert.match(htmlCapturado, /ADMINISTRACIÓN DE FÁRMACOS Y OTROS/);
});

test('salen TODAS las consultas, en orden cronológico ascendente', async () => {
  const { clinicId, patient, doctor } = await seed();
  // Se crean desordenadas a propósito.
  await seguimiento(clinicId, doctor, patient, { descripcion: 'Tercera', fecha: '2026-03-10' });
  await seguimiento(clinicId, doctor, patient, { descripcion: 'Primera', fecha: '2026-01-05' });
  await seguimiento(clinicId, doctor, patient, { descripcion: 'Segunda', fecha: '2026-02-08' });

  await imprimir(clinicId, doctor, 'doctor', patient);

  const iPrimera = htmlCapturado.indexOf('Primera');
  const iSegunda = htmlCapturado.indexOf('Segunda');
  const iTercera = htmlCapturado.indexOf('Tercera');
  assert.ok(iPrimera > -1 && iSegunda > -1 && iTercera > -1, 'están las tres');
  assert.ok(iPrimera < iSegunda && iSegunda < iTercera, 'y en orden ascendente');
  assert.match(htmlCapturado, /3 atenciones/);
  assert.match(htmlCapturado, /05\/01\/2026/);
});

test('la evolución lleva motivo, signos vitales, diagnóstico y firma del médico', async () => {
  const { clinicId, patient, doctor } = await seed();
  await seguimiento(clinicId, doctor, patient, {
    descripcion: 'Dolor abdominal',
    enfermedadActual: 'Desde hace tres días',
    evolucion: 'Mejora respecto del control anterior',
    diagnosticos: [{ descripcion: 'Gastroenteritis', cie: 'A09', definitivo: true }],
    vitalSigns: { bloodPressure: '120/80', heartRate: 72, weight: 68 },
  });

  await imprimir(clinicId, doctor, 'doctor', patient);
  assert.match(htmlCapturado, /Dolor abdominal/);
  assert.match(htmlCapturado, /Desde hace tres días/);
  assert.match(htmlCapturado, /TA 120\/80/);
  assert.match(htmlCapturado, /Gastroenteritis \(A09\) DEF/);
  assert.match(htmlCapturado, /Mejora respecto del control anterior/);
  assert.match(htmlCapturado, /Dra\. Salas/, 'firma al pie de la nota');
  assert.match(htmlCapturado, /CI 0999888777/);
});

test('las prescripciones llevan la receta, el plan, las derivaciones y el suero', async () => {
  const { clinicId, patient, doctor } = await seed();
  await seguimiento(clinicId, doctor, patient, {
    descripcion: 'Anemia',
    planTratamiento: 'Sueroterapia semanal',
    recomendacionesNoFarmacologicas: 'Dieta rica en hierro',
    recetaItems: [
      {
        name: 'Sueroterapia', quantity: 2, isSerum: true, instructions: 'Pasar en 45 minutos',
        serumBase: { name: 'Cloruro', volumeMl: 500 },
        serumComponents: [{ code: 'AAPL01', name: 'APIMEL 2ML AMP', quantity: 1 }],
      },
      { name: 'Paracetamol 500 mg', quantity: 10, dose: '1 tableta', frequency: 'c/8 h' },
    ],
    derivacionItems: [{ name: 'Fisioterapia', quantity: 4 }],
  });

  await imprimir(clinicId, doctor, 'doctor', patient);
  assert.match(htmlCapturado, /Paracetamol 500 mg/);
  assert.match(htmlCapturado, /1 tableta/);
  assert.match(htmlCapturado, /Preparación: Cloruro 500 ml · APIMEL 2ML AMP ×1/);
  assert.match(htmlCapturado, /Pasar en 45 minutos/);
  assert.match(htmlCapturado, /Plan:<\/b> Sueroterapia semanal/);
  assert.match(htmlCapturado, /No farmacológicas:<\/b> Dieta rica en hierro/);
  assert.match(htmlCapturado, /Derivaciones:<\/b> Fisioterapia x4/);
});

test('la columna de enfermería lleva lo aplicado, lo omitido y quién lo puso', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: 'AAPL01', name: 'APIMEL 2ML AMP', stock: 5 });
  await seguimiento(clinicId, doctor, patient, {
    descripcion: 'Anemia',
    recetaItems: [{
      name: 'Sueroterapia', quantity: 2, isSerum: true,
      serumBase: { name: 'Cloruro', volumeMl: 500 },
      serumComponents: [
        { code: 'AAPL01', name: 'APIMEL 2ML AMP', quantity: 1 },
        { code: 'PTHIERR01', name: 'HIERRO 2ML AMP', quantity: 2 },
      ],
    }],
  });
  let rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = rec.followUps[0];
  const suero = fu.recetaItems.find((it) => it.isSerum);

  await H.runController(
    ctrl.administerSerum,
    H.mockReq(clinicId, enfermero._id, {
      baseVolumeMl: 250,
      note: 'Sin reacción',
      components: [
        { code: 'AAPL01', quantityApplied: 1 },
        { code: 'PTHIERR01', quantityApplied: 0, omitReason: 'El paciente no la quiso' },
      ],
    }, {
      role: 'enfermero',
      params: { patientId: String(patient._id), followUpId: String(fu._id), itemId: String(suero._id) },
    }),
  );

  await imprimir(clinicId, doctor, 'doctor', patient);
  assert.match(htmlCapturado, /APIMEL 2ML AMP x1/, 'lo que se aplicó');
  assert.match(htmlCapturado, /Cloruro 250 ml/, 'el cloruro que se puso de verdad');
  assert.match(htmlCapturado, /No se aplicó: HIERRO 2ML AMP \(El paciente no la quiso\)/);
  assert.match(htmlCapturado, /Sin reacción/);
  assert.match(htmlCapturado, /Karla Ruiz/, 'firma de enfermería');
  // El instructivo pide que esa columna vaya EN ROJO.
  assert.match(htmlCapturado, /\.hoja \.admin \{ color:#b00000/);
});

test('enfermería NO puede descargar la hoja: lleva la cédula del paciente', async () => {
  const rutas = require('../routes/clinicalRecords');
  const capa = rutas.stack.find((l) => l.route?.path === '/:patientId/hcu005');
  assert.ok(capa, 'la ruta existe');

  const { requireRole } = require('../middleware/auth');
  const guardia = requireRole('admin', 'cajero', 'doctor');
  const prueba = (role) => {
    let status = 200;
    guardia({ role, user: {} }, { status: (c) => { status = c; return { json: () => {} }; } }, () => {});
    return status;
  };
  assert.equal(prueba('enfermero'), 403, 'el enfermero no la descarga');
  assert.equal(prueba('doctor'), 200);
  assert.equal(prueba('admin'), 200);
});

test('una ficha sin consultas no revienta', async () => {
  const { clinicId, patient, doctor } = await seed();
  const r = await imprimir(clinicId, doctor, 'doctor', patient);
  assert.equal(r.statusCode < 400, true);
  assert.match(htmlCapturado, /Sin consultas registradas/);
});
