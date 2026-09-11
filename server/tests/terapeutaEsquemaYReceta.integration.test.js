/**
 * EL ESQUEMA DE LOS CINCO ELEMENTOS Y LOS RÓTULOS DE SU RECETA.
 *
 * Dos cambios que pidió la clínica (sep-2026) y que tienen que sobrevivir a un
 * ida y vuelta contra la base:
 *
 *  1. LAS FLECHAS LAS DIBUJA EL TERAPEUTA. Antes el gráfico traía pintadas las
 *     dos ruedas clásicas, iguales en todas las consultas; ahora el lienzo nace
 *     limpio y lo que traza es de ESE paciente, así que hay que guardarlo. Se
 *     guarda en unidades del lienzo (141 × 100, ver `CincoElementos.jsx`).
 *
 *  2. ÉL NO RECETA FÁRMACOS. Su receta son suplementos, naturales y
 *     homeopáticos, y sus consejos son «coaching de cambio de hábitos». El
 *     dato guardado es el mismo de siempre — lo que cambia es el rótulo, y el
 *     PDF lo saca del ROL CON EL QUE SE ESCRIBIÓ la consulta, no de quien lo
 *     imprime: la hoja se llama igual la abra él o la abra el administrador.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');
const { RECETA_ETIQUETAS } = require('../constants/specialtyCatalogs');

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
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez' });
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

// ───────────────────── las flechas del esquema ─────────────────────

test('las flechas que dibuja el terapeuta se guardan y se vuelven a leer', async () => {
  const { clinicId, patient, terapeuta } = await seed();

  const r = await crearFu(clinicId, terapeuta, patient, {
    descripcion: 'Primera valoración',
    terapia: {
      elementos: [{ key: 'fuego', texto: 'Insomnio' }],
      flechas: [
        { x1: 35, y1: 12, x2: 100, y2: 40, tipo: 'apoyo' },
        { x1: 100, y1: 45, x2: 40, y2: 80, tipo: 'control' },
      ],
    },
  }, 'terapeuta');
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = rec.followUps.find((f) => f.createdByRole === 'terapeuta');
  assert.equal(fu.terapia.flechas.length, 2);
  assert.deepEqual(
    fu.terapia.flechas.map((f) => f.tipo),
    ['apoyo', 'control'],
    'el ciclo de cada flecha es dato clínico: gris apoya, negra controla',
  );
  assert.equal(fu.terapia.flechas[0].x1, 35);
  assert.equal(fu.terapia.flechas[1].y2, 80);
});

test('una flecha con basura dentro no entra, y el resto del esquema sí', async () => {
  const { clinicId, patient, terapeuta } = await seed();

  const r = await crearFu(clinicId, terapeuta, patient, {
    descripcion: 'Control',
    terapia: {
      elementos: [{ key: 'agua', texto: 'Frío de riñón' }],
      flechas: [
        { x1: 'hola', y1: 12, x2: 100, y2: 40, tipo: 'apoyo' },   // no es número
        { x1: 5, y1: 5, x2: 9999, y2: 40, tipo: 'control' },      // fuera del lienzo
        { x1: 20, y1: 20, x2: 60, y2: 60, tipo: 'inventado' },    // ciclo que no existe
      ],
    },
  }, 'terapeuta');
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = rec.followUps.find((f) => f.createdByRole === 'terapeuta');
  assert.equal(fu.terapia.flechas.length, 1, 'solo sobrevive la que se puede volver a pintar');
  assert.equal(fu.terapia.flechas[0].tipo, 'control', 'un ciclo desconocido cae al de control');
  assert.equal(fu.terapia.elementos[0].texto, 'Frío de riñón', 'lo escrito no se pierde por una fila mala');
});

// ───────────────────── TERAPIAS COMPLEMENTARIAS ─────────────────────
//
// Viven en la FICHA del paciente (su propia pestaña, junto a Ficha clínica y
// Datos), no dentro de un seguimiento: se guardan por PUT /clinical-records/:id
// y solo las escribe el terapeuta (o administración).

/** Guarda las terapias complementarias del paciente, como lo hace la pestaña. */
const guardarTerapias = (clinicId, quien, patient, tcs, role = 'terapeuta') =>
  H.runController(
    ctrl.updateByPatient,
    H.mockReq(clinicId, quien._id, { terapiasComplementarias: tcs },
      { role, params: { patientId: String(patient._id) } }),
  );

test('biomagnetismo, mapa floral y masaje se guardan en la ficha del paciente', async () => {
  const { clinicId, patient, terapeuta } = await seed();

  const r = await guardarTerapias(clinicId, terapeuta, patient, {
    biomagnetismo: {
      objetivo: 'Drenaje linfático',
      protocoloSeleccionado: 'Protocolo emocional',
      sesionesEstimadas: '4',
      protocoloParSeleccionado: 'Riñón – Vejiga',
    },
    terapiaFloral: {
      mapaFloral: [
        { numero: '25', nombre: 'lo que mandó la pantalla' }, // el número manda
        { numero: '', nombre: 'Willow – Sauce' },
      ],
      objetivoFormula: 'Soltar el resentimiento',
      afirmacionTerapeutica: 'Perdono y avanzo',
      tareasTerapia: 'Escribir el diario tres veces por semana',
    },
    masajeTerapeutico: {
      zonaTrabajada: 'Espalda alta',
      tensionInicial: '8',
      tecnicaUtilizada: 'Amasamiento profundo',
      presion: 'moderada',
      aceiteUtilizado: 'Almendras + lavanda',
      aromaterapia: 'Lavanda',
      floresApoyo: 'Rescate',
      tiempo: '45 min',
      respuestaInmediata: 'Relajación profunda',
      tensionFinal: '3',
      observaciones: 'Zona lumbar sensible',
      recomendaciones: 'Hidratación y estiramientos',
      proximaSesion: 'En dos semanas',
    },
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const t = rec.terapiasComplementarias;

  assert.equal(t.biomagnetismo.objetivo, 'Drenaje linfático');
  assert.equal(t.biomagnetismo.protocoloParSeleccionado, 'Riñón – Vejiga');

  // El número manda: la fila se guarda con el nombre OFICIAL del catálogo.
  assert.equal(t.terapiaFloral.mapaFloral.length, 2);
  assert.equal(t.terapiaFloral.mapaFloral[0].numero, '25');
  assert.equal(t.terapiaFloral.mapaFloral[0].nombre, 'Red Chestnut – Castaño Rojo');
  assert.equal(t.terapiaFloral.mapaFloral[1].numero, '38');
  assert.equal(t.terapiaFloral.objetivoFormula, 'Soltar el resentimiento');

  assert.equal(t.masajeTerapeutico.presion, 'moderada');
  assert.equal(t.masajeTerapeutico.tensionInicial, '8');
  assert.equal(t.masajeTerapeutico.proximaSesion, 'En dos semanas');
  assert.ok(t.updatedBy, 'queda constancia de quién guardó');
});

test('una fila del mapa floral que no es ninguna flor de Bach no entra', async () => {
  const { clinicId, patient, terapeuta } = await seed();

  const r = await guardarTerapias(clinicId, terapeuta, patient, {
    terapiaFloral: {
      mapaFloral: [
        { numero: '', nombre: 'sausaje' },          // no existe
        { numero: '99', nombre: '' },               // número fuera del sistema
        { numero: '38', nombre: '' },               // válida: solo número
        { numero: '', nombre: 'SAUCE' },            // válida: mayúsculas y sin resolver
      ],
    },
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const filas = rec.terapiasComplementarias.terapiaFloral.mapaFloral;
  assert.equal(filas.length, 2, 'solo las flores de verdad');
  assert.equal(filas[0].numero, '38');
  assert.equal(filas[0].nombre, 'Willow – Sauce', 'el nombre se normaliza al oficial');
  assert.equal(filas[1].nombre, 'Willow – Sauce');
});

test('una presión que no es de la hoja se descarta, y el resto del masaje queda', async () => {
  const { clinicId, patient, terapeuta } = await seed();

  const r = await guardarTerapias(clinicId, terapeuta, patient, {
    masajeTerapeutico: {
      zonaTrabajada: 'Cuello',
      presion: 'muy fuerte',   // no está en la hoja
    },
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const mj = rec.terapiasComplementarias.masajeTerapeutico;
  assert.equal(mj.presion, '', 'una presión inventada no se guarda');
  assert.equal(mj.zonaTrabajada, 'Cuello');
});

test('quien no ve la terapia del terapeuta tampoco puede escribirla', async () => {
  const { clinicId, patient, doctor } = await seed();

  const r = await guardarTerapias(clinicId, doctor, patient, {
    biomagnetismo: { objetivo: 'intento desde otro rol' },
  }, 'doctor');
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.ok(
    !rec.terapiasComplementarias?.biomagnetismo?.objetivo,
    'el guardado de un rol sin permiso no toca la sección',
  );
});

// ───────────────────── los rótulos de la receta ─────────────────────

test('la receta del terapeuta se imprime con SUS rótulos', async () => {
  const { clinicId, patient, terapeuta } = await seed();

  const r = await crearFu(clinicId, terapeuta, patient, {
    descripcion: 'Plan de arranque',
    recetaItems: [{ name: 'Magnesio quelado', quantity: 1, dose: '1 cápsula', frequency: 'noche' }],
    recomendacionesNoFarmacologicas: 'Cenar tres horas antes de dormir',
  }, 'terapeuta');
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = rec.followUps.find((f) => f.createdByRole === 'terapeuta');

  // La imprime EL ADMINISTRADOR: el rótulo lo manda quien la escribió, no quien
  // la saca.
  const pdf = await correrPdf(
    ctrl.printFollowUp,
    H.mockReq(clinicId, terapeuta._id, {}, {
      role: 'admin',
      params: { patientId: String(patient._id), followUpId: String(fu._id) },
    }),
  );
  assert.equal(pdf.statusCode < 400, true, JSON.stringify(pdf.payload).slice(0, 200));
  assert.ok(htmlCapturado.includes(RECETA_ETIQUETAS.terapeuta.item), 'la columna es de suplementos, no de medicamentos');
  assert.ok(htmlCapturado.includes(RECETA_ETIQUETAS.terapeuta.consejos), 'sus consejos son el coaching de hábitos');
  assert.ok(!htmlCapturado.includes(RECETA_ETIQUETAS.general.item));
  assert.ok(!htmlCapturado.includes(RECETA_ETIQUETAS.general.consejos));
});

test('la receta del doctor sigue diciendo «Medicamento / Insumo»', async () => {
  const { clinicId, patient, doctor } = await seed();

  const r = await crearFu(clinicId, doctor, patient, {
    descripcion: 'Control',
    recetaItems: [{ name: 'Paracetamol 500 mg', quantity: 1, dose: '1 tableta', frequency: 'c/8 h' }],
    recomendacionesNoFarmacologicas: 'Hidratación',
  }, 'doctor');
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = rec.followUps.find((f) => f.createdByRole === 'doctor');

  const pdf = await correrPdf(
    ctrl.printFollowUp,
    H.mockReq(clinicId, doctor._id, {}, {
      role: 'doctor',
      params: { patientId: String(patient._id), followUpId: String(fu._id) },
    }),
  );
  assert.equal(pdf.statusCode < 400, true, JSON.stringify(pdf.payload).slice(0, 200));
  assert.ok(htmlCapturado.includes(RECETA_ETIQUETAS.general.item));
  assert.ok(htmlCapturado.includes(RECETA_ETIQUETAS.general.consejos));
  assert.ok(!htmlCapturado.includes(RECETA_ETIQUETAS.terapeuta.item));
});
