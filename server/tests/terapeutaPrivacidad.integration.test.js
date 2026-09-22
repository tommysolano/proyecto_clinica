/**
 * LA CONSULTA DEL TERAPEUTA ES PRIVADA.
 *
 * La clínica decidió que lo que escribe el terapeuta lo ven SOLO él y la
 * administración. Al resto —doctores, especialidades, enfermería, mostrador— les
 * aparece en la historia que ese día hubo una atención, y nada más:
 * «Atendido por terapeuta».
 *
 * Ojo con el contexto: el repo ya quitó una vez un recorte parecido para
 * enfermería, y lo dejó escrito («el recorte no protegía nada»). Aquello se
 * quitó porque escondía lo que evita una reacción; esto se pone porque la
 * información en sí es reservada. No es la misma decisión.
 *
 * Lo que vigilan estos tests es cada puerta por la que el dato puede salir:
 *  1. la API (siete `res.json` devuelven la ficha entera);
 *  2. los PDF, que consultan Mongo por su cuenta y son la fuga de verdad — la
 *     guardia de la ruta NO basta porque `requireRole('doctor')` expande a
 *     TODAS las especialidades;
 *  3. la ficha propia del terapeuta (`fichaTerapia`);
 *  4. que el recorte NO se coma las consultas de los demás.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');

// Doble de puppeteer que captura el HTML en vez de abrir un navegador (mismo
// truco que hcu005.integration.test.js).
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

/** Ejecuta un controlador de PDF: responde con res.end(buffer), no con res.json. */
const correrPdf = async (fn, req) => {
  const state = { statusCode: 200, payload: undefined, headers: {} };
  const res = {
    status: (c) => { state.statusCode = c; return res; },
    json: (p) => { state.payload = p; return res; },
    send: (p) => { state.payload = p; return res; },
    setHeader: (n, v) => { state.headers[n] = v; return res; },
    end: (b) => { state.payload = b; return res; },
  };
  await fn(req, res);
  return state;
};

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); htmlCapturado = ''; });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });
  const terapeuta = await crear('Tere', 'terapeuta');
  const doctor = await crear('DraSalas', 'doctor');
  return { clinicId, userId, patient, terapeuta, doctor };
}

const crearFu = (clinicId, quien, patient, body, role) =>
  H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, quien._id, body, { role, params: { patientId: String(patient._id) } }),
  );

const leerFicha = (clinicId, quien, patient, role, query = {}) =>
  H.runController(
    ctrl.getOrCreateByPatient,
    H.mockReq(clinicId, quien._id, {}, { role, query, params: { patientId: String(patient._id) } }),
  );

/** Deja una consulta del terapeuta y otra de un doctor. Devuelve sus ids. */
async function dosConsultas(clinicId, terapeuta, doctor, patient) {
  const t = await crearFu(clinicId, terapeuta, patient, {
    descripcion: 'Desequilibrio de Fuego',
    terapia: {
      elementos: [{ key: 'fuego', texto: 'Exceso de calor, insomnio' }],
      foda: { toxinas: 'Carga hepática alta' },
      plan: 'Drenaje hepático 3 semanas',
    },
  }, 'terapeuta');
  assert.equal(t.statusCode < 400, true, JSON.stringify(t.payload));

  const d = await crearFu(clinicId, doctor, patient, {
    descripcion: 'Control de presión',
    planTratamiento: 'Seguir con el enalapril',
  }, 'doctor');
  assert.equal(d.statusCode < 400, true, JSON.stringify(d.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  return {
    fuTerapia: rec.followUps.find((f) => f.createdByRole === 'terapeuta'),
    fuDoctor: rec.followUps.find((f) => f.createdByRole === 'doctor'),
  };
}

// ───────────────────────── la API ─────────────────────────

test('el terapeuta guarda su consulta y la vuelve a leer entera', async () => {
  const { clinicId, patient, terapeuta, doctor } = await seed();
  await dosConsultas(clinicId, terapeuta, doctor, patient);

  const r = await leerFicha(clinicId, terapeuta, patient, 'terapeuta');
  assert.equal(r.statusCode < 400, true);
  const fu = r.payload.followUps.find((f) => f.createdByRole === 'terapeuta');
  assert.equal(fu.descripcion, 'Desequilibrio de Fuego');
  assert.equal(fu.terapia.elementos[0].texto, 'Exceso de calor, insomnio');
  assert.equal(fu.terapia.foda.toxinas, 'Carga hepática alta');
  assert.equal(fu.terapia.plan, 'Drenaje hepático 3 semanas');
});

test('a los demás roles solo les llega «Atendido por terapeuta»', async () => {
  const { clinicId, userId, patient, terapeuta, doctor } = await seed();
  await dosConsultas(clinicId, terapeuta, doctor, patient);

  for (const rol of ['doctor', 'odontologia', 'enfermero', 'cajero', 'optica']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await leerFicha(clinicId, userId, patient, rol);
    assert.equal(r.statusCode < 400, true, `${rol}: ${JSON.stringify(r.payload)}`);

    const fu = r.payload.followUps.find((f) => f.createdByRole === 'terapeuta');
    assert.ok(fu, `${rol}: la atención tiene que SEGUIR APARECIENDO en la historia`);
    assert.equal(fu.descripcion, 'Atendido por terapeuta', `${rol} no puede leer el motivo`);
    assert.equal(fu.redacted, true);
    assert.equal(fu.terapia, undefined, `${rol} no puede recibir la ficha de terapia`);
    assert.equal(fu.planTratamiento, undefined);
    assert.equal(fu.observaciones, undefined);

    // Y lo de los demás no se toca… salvo para ENFERMERÍA (sep-2026): su vista
    // de la historia va recortada a suero/comentarios, sin consultas ajenas.
    const otro = r.payload.followUps.find((f) => f.createdByRole === 'doctor');
    if (rol === 'enfermero') {
      assert.equal(otro.descripcion, '', 'enfermería ve la historia recortada (ver sueroDeEnfermeria)');
    } else {
      assert.equal(otro.descripcion, 'Control de presión', `${rol} sí ve la consulta del doctor`);
      assert.equal(otro.planTratamiento, 'Seguir con el enalapril');
    }
  }
});

test('el administrador sí lee la consulta del terapeuta', async () => {
  const { clinicId, userId, patient, terapeuta, doctor } = await seed();
  await dosConsultas(clinicId, terapeuta, doctor, patient);

  const r = await leerFicha(clinicId, userId, patient, 'admin');
  const fu = r.payload.followUps.find((f) => f.createdByRole === 'terapeuta');
  assert.equal(fu.descripcion, 'Desequilibrio de Fuego');
  assert.equal(fu.terapia.plan, 'Drenaje hepático 3 semanas');
});

/**
 * CON RECETA PEDIDA (`?conReceta=true`), la receta del terapeuta SÍ sale (sep-2026).
 *
 * Es la puerta que usa «Asignar atención» para ofrecer los sueros pendientes:
 * sin esto, el suero que recetó el terapeuta no aparecía en esa lista y la cita
 * llegaba al enfermero sin nada que aplicar. Lo que se abre es EXACTAMENTE la
 * receta —los ítems y las recomendaciones, lo que la hoja imprime— y NADA de la
 * consulta. Sin el parámetro, como siempre: el tocón.
 */
test('con ?conReceta la ficha entrega la receta del terapeuta, la consulta sigue sellada', async () => {
  const { clinicId, userId, patient, terapeuta } = await seed();
  await crearFu(clinicId, terapeuta, patient, {
    descripcion: 'Desequilibrio de Fuego',
    observaciones: 'Notas privadas de la sesión',
    planTratamiento: 'Drenaje hepático 3 semanas',
    recetaItems: [{
      name: 'Sueroterapia', quantity: 3, isSerum: true,
      serumBase: { name: 'Cloruro', volumeMl: 500 },
      serumComponents: [{ name: 'CEREBRAIN 2ML AMP', quantity: 2 }],
    }],
    recomendacionesNoFarmacologicas: 'Cenar tres horas antes de dormir',
  }, 'terapeuta');

  // Con el parámetro: la receta sale, el resto sigue privado.
  const conReceta = await leerFicha(clinicId, userId, patient, 'cajero', { conReceta: 'true' });
  const fu = conReceta.payload.followUps.find((f) => f.createdByRole === 'terapeuta');
  assert.equal(fu.redacted, true, 'la consulta sigue sellada');
  assert.equal(fu.descripcion, 'Atendido por terapeuta', 'el motivo sigue privado');
  assert.equal(fu.planTratamiento, undefined, 'el plan sigue privado');
  assert.equal(fu.observaciones, undefined, 'las observaciones siguen privadas');
  assert.equal(fu.recetaItems.length, 1, 'la RECETA sí sale por esta puerta');
  assert.equal(fu.recetaItems[0].name, 'Sueroterapia');
  assert.ok(fu.recetaItems[0].isSerum, 'el suero sale con su sello para enfermería');

  // Y sin el parámetro (la ficha normal), como siempre: tocón sin receta.
  const normal = await leerFicha(clinicId, userId, patient, 'cajero');
  const fuNormal = normal.payload.followUps.find((f) => f.createdByRole === 'terapeuta');
  assert.deepEqual(fuNormal.recetaItems, [], 'sin el parámetro la receta NO sale');
  assert.equal(fuNormal.recomendacionesNoFarmacologicas, undefined);
});

// ───────────────────── la ficha propia ─────────────────────

test('la ficha del terapeuta solo la ve (y solo la guarda) él y el admin', async () => {
  const { clinicId, userId, patient, terapeuta } = await seed();

  const guardar = (quien, role, body) =>
    H.runController(
      ctrl.updateByPatient,
      H.mockReq(clinicId, quien._id, body, { role, params: { patientId: String(patient._id) } }),
    );

  const r = await guardar(terapeuta, 'terapeuta', {
    fichaTerapia: {
      alergias: 'Ninguna conocida',
      habitos: [
        { fila: 'digestion', nivel: '2', diario: 'Pesadez después de comer' },
        { fila: 'estres', nivel: '3', diario: '' },
        { fila: 'sueno', nivel: '', diario: '' },       // vacía: no se guarda
        { fila: 'inventada', nivel: '1', diario: 'x' }, // fuera del catálogo
      ],
    },
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.deepEqual(
    rec.fichaTerapia.habitos.map((h) => [h.fila, h.nivel, h.diario]),
    [['digestion', '2', 'Pesadez después de comer'], ['estres', '3', '']],
    'solo filas del catálogo y solo las que dicen algo',
  );

  // Un doctor no la recibe…
  const comoDoctor = await leerFicha(clinicId, userId, patient, 'doctor');
  assert.equal(comoDoctor.payload.fichaTerapia, undefined);

  // …y guardando la ficha MSP no puede borrarla.
  const pisar = await guardar({ _id: userId }, 'doctor', {
    nombre: 'Ana Pérez',
    fichaTerapia: { alergias: '', habitos: [] },
  });
  assert.equal(pisar.statusCode < 400, true, JSON.stringify(pisar.payload));
  const despues = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.equal(
    despues.fichaTerapia.habitos.length, 2,
    'quien no la ve tampoco la guarda: si no, un guardado cualquiera la vaciaría',
  );
});

// ───────────────────────── los PDF ─────────────────────────

test('los PDF no son una puerta de atrás: la receta y la hoja MSP dan 403', async () => {
  const { clinicId, userId, patient, terapeuta, doctor } = await seed();
  const { fuTerapia, fuDoctor } = await dosConsultas(clinicId, terapeuta, doctor, patient);

  const pdf = (fn, quien, role, followUpId) =>
    correrPdf(
      fn,
      H.mockReq(clinicId, quien, {}, {
        role,
        params: { patientId: String(patient._id), followUpId: String(followUpId) },
      }),
    );

  for (const rol of ['doctor', 'odontologia', 'cajero']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pdf(ctrl.printFollowUp, userId, rol, fuTerapia._id);
    assert.equal(r.statusCode, 403, `${rol} no puede imprimir la receta del terapeuta`);
    // eslint-disable-next-line no-await-in-loop
    const m = await pdf(ctrl.printMspForm, userId, rol, fuTerapia._id);
    assert.equal(m.statusCode, 403, `${rol} no puede imprimir su hoja MSP`);
  }

  // La del doctor se imprime como siempre.
  const ok = await pdf(ctrl.printFollowUp, userId, 'doctor', fuDoctor._id);
  assert.equal(ok.statusCode < 400, true, JSON.stringify(ok.payload).slice(0, 200));

  // Y el terapeuta imprime la suya.
  const suya = await pdf(ctrl.printFollowUp, terapeuta._id, 'terapeuta', fuTerapia._id);
  assert.equal(suya.statusCode < 400, true, JSON.stringify(suya.payload).slice(0, 200));
});

test('los ADJUNTOS de una consulta del terapeuta tampoco se bajan', async () => {
  /**
   * La otra puerta al contenido. Cerrar el PDF y dejar abierto el archivo no
   * cierra nada: la ruta de adjuntos es `allRoles` (admin, cajero, doctor) y
   * `doctor` expande a TODAS las especialidades.
   */
  const { clinicId, userId, patient, terapeuta, doctor } = await seed();
  const { fuTerapia, fuDoctor } = await dosConsultas(clinicId, terapeuta, doctor, patient);

  const bajar = (role, followUpId) =>
    H.runController(
      ctrl.downloadFollowUpAttachment,
      H.mockReq(clinicId, userId, {}, {
        role,
        params: {
          patientId: String(patient._id),
          followUpId: String(followUpId),
          attachmentId: '000000000000000000000009',
        },
      }),
    );

  for (const rol of ['doctor', 'odontologia', 'cajero', 'enfermero']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await bajar(rol, fuTerapia._id);
    assert.equal(r.statusCode, 403, `${rol} no puede bajar un adjunto del terapeuta`);
  }
  // En la del doctor la guardia no se mete: llega hasta «archivo no encontrado».
  const otro = await bajar('doctor', fuDoctor._id);
  assert.equal(otro.statusCode, 404, 'la de un doctor sigue funcionando como siempre');
});

test('la cita que se registra sola no publica el motivo del terapeuta en la agenda', async () => {
  /**
   * Fuga por la puerta de al lado: al guardar sin cita, el sistema registra una
   * y le pone el motivo como nombre del servicio. La agenda la ve toda la
   * clínica, así que el seguimiento quedaba recortado y el motivo publicado.
   */
  const { clinicId, patient, terapeuta } = await seed();
  const r = await crearFu(clinicId, terapeuta, patient, {
    descripcion: 'Bloqueo emocional por duelo',
  }, 'terapeuta');
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const Appointment = require('../models/Appointment');
  const cita = await Appointment.findOne({ clinic: clinicId, patient: patient._id }).lean();
  assert.ok(cita, 'la atención se registra igual');
  assert.equal(cita.serviceName, 'Terapia');
  const enLaAgenda = JSON.stringify(cita);
  assert.ok(
    !enLaAgenda.includes('Bloqueo emocional'),
    'el motivo no puede acabar en ningún campo de la cita: la agenda la ve todo el mundo',
  );
});

test('la historia completa (HCU-005) sale SIN las consultas del terapeuta', async () => {
  const { clinicId, userId, patient, terapeuta, doctor } = await seed();
  await dosConsultas(clinicId, terapeuta, doctor, patient);

  const hcu = (quien, role) =>
    correrPdf(
      ctrl.printHcu005,
      H.mockReq(clinicId, quien, {}, { role, params: { patientId: String(patient._id) } }),
    );

  const comoDoctor = await hcu(userId, 'doctor');
  assert.equal(comoDoctor.statusCode < 400, true);
  const htmlDoctor = htmlCapturado;
  assert.ok(htmlDoctor.includes('Control de presión'), 'la consulta del doctor sí sale');
  assert.ok(
    !htmlDoctor.includes('Desequilibrio de Fuego') && !htmlDoctor.includes('Drenaje hepático'),
    'esta era la fuga de verdad: el PDF lee Mongo por su cuenta y se saltaba el recorte de la API',
  );

  const comoAdmin = await hcu(userId, 'admin');
  assert.ok(htmlCapturado.includes('Desequilibrio de Fuego'), 'el admin la ve entera');
});
