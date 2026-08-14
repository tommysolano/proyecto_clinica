/**
 * ROLES DE ESPECIALIDAD (podología, odontología, cosmetología) y sus fichas en el
 * seguimiento.
 *
 * Dos cosas que se rompen en silencio si nadie las vigila:
 *  1. Un rol nuevo que no esté en la expansión "doctor-like" da 403 en todas las
 *     rutas que declaran requireRole('doctor') — o peor, ve datos que no le tocan.
 *  2. El saneador del seguimiento descarta lo que no esté en el catálogo. Si una
 *     `key` del cliente no coincide con la del servidor, el dato se guarda vacío
 *     sin ningún error visible.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const clinicalRecords = require('../controllers/clinicalRecordController');
const { can } = require('../utils/permissions');
const { DOCTOR_LIKE_ROLES, DOCTOR_SPECIALTY_ROLES, VALID_ROLES, isDoctorRole } = require('../constants/roles');
const {
  PODOLOGIA_HALLAZGOS_KEYS,
  ODONTOGRAMA_PIEZAS,
  COSMETOLOGIA_LESIONES_KEYS,
} = require('../constants/specialtyCatalogs');
const { specialtyFollowUpHtml } = require('../utils/specialtyFollowUpPrint');

const NUEVOS = ['podologia', 'odontologia', 'cosmetologia'];

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const run = (h, req) => H.runController(h, req);
const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

/** Paciente + ficha clínica ya creada (addFollowUp no crea la ficha). */
async function seedPaciente(clinicId, userId) {
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  return patient;
}

/** Cuerpo mínimo aceptado por addFollowUp (exige motivo y al menos un ítem). */
const baseBody = (extra = {}) => ({
  descripcion: 'Consulta',
  recetaItems: [{ name: 'Gasas', quantity: 1 }],
  ...extra,
});

const postFollowUp = async (clinicId, userId, patientId, role, body) =>
  run(clinicalRecords.addFollowUp,
    H.mockReq(clinicId, userId, body, { role, params: { patientId: String(patientId) } }));

// ═════════════════ Roles ═════════════════

test('E1) los tres roles nuevos son doctores para todo el backend', () => {
  for (const rol of NUEVOS) {
    assert.ok(VALID_ROLES.includes(rol), `${rol} debe poder asignarse a un usuario`);
    assert.ok(DOCTOR_LIKE_ROLES.includes(rol), `${rol} debe contar como doctor`);
    assert.ok(DOCTOR_SPECIALTY_ROLES.includes(rol), `${rol} debe expandir requireRole('doctor')`);
    assert.equal(isDoctorRole(rol), true);
    // Heredan las capacidades del rol 'doctor' (que hoy no tiene ninguna fina):
    // lo importante es que NO caigan en el saco de "rol desconocido" con nada.
    assert.equal(can(rol, 'inventory.costs'), can('doctor', 'inventory.costs'), `${rol} = doctor en costos`);
    assert.equal(can(rol, 'sales.export'), can('doctor', 'sales.export'), `${rol} = doctor en exportar`);
  }
  assert.equal(isDoctorRole('cajero'), false);
  assert.equal(isDoctorRole('rol_inventado'), false);
});

test('E2) requireRole("doctor") acepta las especialidades y sigue rechazando al resto', () => {
  const { requireRole } = require('../middleware/auth');
  const intenta = (role) => {
    let paso = false;
    let status = 0;
    requireRole('doctor')(
      { role, user: {} },
      { status: (c) => { status = c; return { json: () => {} }; } },
      () => { paso = true; },
    );
    return { paso, status };
  };
  for (const rol of [...NUEVOS, 'doctor', 'ginecologia', 'optica']) {
    assert.equal(intenta(rol).paso, true, `${rol} debería pasar requireRole('doctor')`);
  }
  assert.deepEqual(intenta('cajero'), { paso: false, status: 403 });
  assert.deepEqual(intenta('marketing'), { paso: false, status: 403 });
});

// ═════════════════ Ficha podológica ═════════════════

test('E3) el seguimiento de podología guarda su ficha completa', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'podologia', baseBody({
    podologia: {
      hallazgosGenerales: {
        piel: 'seca', unas: 'engrosadas', hidratacion: 'baja',
        temperatura: 'normal', coloracion: 'pálida', edema: true, otros: 'ninguno',
      },
      vascularNeurologica: {
        pulsoPedio: 'presente', pulsoTibialPosterior: 'ausente', llenadoCapilar: '3 seg',
        sensibilidadMonofilamento: 'disminuida', reflejos: 'presentes',
      },
      evaluacion: { piel: 'xerótica', unas: 'micosis', pulsos: 'ok', sensibilidad: 'baja', calzado: 'estrecho', marcha: 'antálgica' },
      hallazgos: [
        { key: 'onicomicosis', marked: true },
        { key: 'helomaDuro', marked: true },
      ],
      hallazgosDetalle: 'Heloma en 1er dedo del pie derecho',
    },
  })));

  const fu = payload.followUps.at(-1);
  assert.equal(fu.podologia.hallazgosGenerales.piel, 'seca');
  assert.equal(fu.podologia.hallazgosGenerales.edema, true);
  assert.equal(fu.podologia.vascularNeurologica.pulsoTibialPosterior, 'ausente');
  assert.equal(fu.podologia.vascularNeurologica.sensibilidadMonofilamento, 'disminuida');
  assert.equal(fu.podologia.evaluacion.marcha, 'antálgica');
  assert.deepEqual(fu.podologia.hallazgos.map((h) => h.key), ['onicomicosis', 'helomaDuro']);
  assert.equal(fu.podologia.hallazgosDetalle, 'Heloma en 1er dedo del pie derecho');
});

test('E4) podología descarta opciones y casillas que no están en el catálogo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'podologia', baseBody({
    podologia: {
      vascularNeurologica: { pulsoPedio: 'quizas', reflejos: 'ausentes' },
      hallazgos: [
        { key: 'onicomicosis', marked: true },
        { key: 'inventado_por_el_cliente', marked: true },
      ],
    },
  })));

  const p = payload.followUps.at(-1).podologia;
  assert.equal(p.vascularNeurologica.pulsoPedio, '', 'una opción fuera del catálogo se guarda vacía, no rompe');
  assert.equal(p.vascularNeurologica.reflejos, 'ausentes');
  assert.deepEqual(p.hallazgos.map((h) => h.key), ['onicomicosis']);
  assert.ok(PODOLOGIA_HALLAZGOS_KEYS.includes('onicomicosis'));
});

// ═════════════════ Odontograma ═════════════════

test('E5) el odontograma guarda solo las piezas marcadas y en orden del esquema', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'odontologia', baseBody({
    odontologia: {
      odontograma: [
        // Llega desordenado (orden de clic) y con basura mezclada.
        { diente: '36', estado: 'caries', caras: { oclusal: true }, nota: 'profunda' },
        { diente: '11', estado: 'obturado', caras: {} },
        { diente: '99', estado: 'caries' },                    // pieza inexistente
        { diente: '21', estado: 'estado_inventado' },          // estado fuera del catálogo
        { diente: '22' },                                      // sin nada: no aporta
      ],
      observaciones: 'Revisar en 6 meses',
    },
  })));

  const o = payload.followUps.at(-1).odontologia;
  assert.deepEqual(o.odontograma.map((d) => d.diente), ['11', '36'], 'ordenadas por el esquema FDI');
  assert.equal(o.odontograma[0].estado, 'obturado');
  assert.equal(o.odontograma[1].caras.oclusal, true);
  assert.equal(o.odontograma[1].nota, 'profunda');
  assert.equal(o.observaciones, 'Revisar en 6 meses');
  assert.ok(!ODONTOGRAMA_PIEZAS.includes('99'), 'la 99 no existe en FDI');
});

// ═════════════════ Ficha cosmetológica ═════════════════

test('E6) el seguimiento de cosmetología guarda sus seis secciones', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'cosmetologia', baseBody({
    cosmetologia: {
      datosEsteticos: { tratamientosEsteticos: 'peeling', autotratamientos: 'ninguno', cosmeticosUsoActual: 'FPS 50' },
      evaluacion: {
        fototipo: 'III', glogau: 'II', rosacea: 'I',
        biotipo: [{ key: 'mixta', marked: true }],
        arrugas: [{ key: 'patasGallo', marked: true }],
        acne: [{ key: 'tipoI', marked: true }],
        lesionesElementales: [{ key: 'melasma', marked: true }, { key: 'no_existe', marked: true }],
        hiperpigmentaciones: [
          { key: 'tercioMedio', marked: true, derecho: true, izquierdo: false },
          { key: 'ovaloFacial', marked: false, derecho: false, izquierdo: false }, // vacía: se descarta
        ],
        deshidratacionFacial: 'moderada',
        bioestimulacion: 'sí', nutricionDermica: 'ácido hialurónico',
        observaciones: 'Piel mixta con melasma centrofacial',
      },
      higiene: { frecuenciaLavado: 'interdiario', shampoo: 'neutro', acondicionador: 'sin siliconas', otros: '—' },
      cabello: {
        longitud: 'medio', forma: 'cinotrico', calibre: 'fino', densidad: 'media',
        elasticidad: 'reducida', color: 'coloracion',
        tratamientos: { alisados: true, planchas: false, secadores: true },
      },
      cueroCabelludo: { tipo: 'graso', glandulaSebacea: 'hiperfuncionante', sensibilidad: 'sensible', movilidad: 'normal' },
      procedimiento: { procedimiento: 'Limpieza profunda', productos: 'Ácido mandélico', apoyoDomiciliario: 'FPS diario' },
    },
  })));

  const c = payload.followUps.at(-1).cosmetologia;
  assert.equal(c.datosEsteticos.cosmeticosUsoActual, 'FPS 50');
  assert.equal(c.evaluacion.fototipo, 'III');
  assert.equal(c.evaluacion.deshidratacionFacial, 'moderada');
  assert.deepEqual(c.evaluacion.biotipo.map((b) => b.key), ['mixta']);
  assert.deepEqual(c.evaluacion.lesionesElementales.map((l) => l.key), ['melasma'], 'la clave inventada se descarta');
  assert.ok(COSMETOLOGIA_LESIONES_KEYS.includes('melasma'));
  assert.deepEqual(c.evaluacion.hiperpigmentaciones.map((z) => z.key), ['tercioMedio']);
  assert.equal(c.evaluacion.hiperpigmentaciones[0].derecho, true);
  assert.equal(c.higiene.frecuenciaLavado, 'interdiario');
  assert.equal(c.cabello.forma, 'cinotrico');
  assert.equal(c.cabello.tratamientos.alisados, true);
  assert.equal(c.cabello.tratamientos.planchas, false);
  assert.equal(c.cueroCabelludo.glandulaSebacea, 'hiperfuncionante');
  assert.equal(c.procedimiento.apoyoDomiciliario, 'FPS diario');
});

test('E6b) fibra capilar y afecciones del cuero cabelludo guardan su detalle por casilla', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'cosmetologia', baseBody({
    cosmetologia: {
      fibraCapilar: [
        { key: 'tricorrexisNudosa', marked: true, detail: 'zona occipital' },
        { key: 'no_existe', marked: true },
      ],
      afeccionesCuero: [
        { key: 'alopecia', marked: true, detail: 'androgénica' },
        { key: 'seborrea', marked: true },
      ],
    },
  })));

  const c = payload.followUps.at(-1).cosmetologia;
  assert.deepEqual(c.fibraCapilar.map((f) => f.key), ['tricorrexisNudosa']);
  assert.equal(c.fibraCapilar[0].detail, 'zona occipital');
  assert.deepEqual(c.afeccionesCuero.map((a) => a.key), ['alopecia', 'seborrea']);
  assert.equal(c.afeccionesCuero[0].detail, 'androgénica', 'el TIPO de alopecia va en el detalle');
});

test('E7) opciones fuera de catálogo en cosmetología no se guardan', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'cosmetologia', baseBody({
    cosmetologia: {
      evaluacion: { fototipo: 'IX', deshidratacionFacial: 'extrema' },
      cabello: { forma: 'rizado_total', longitud: 'corto' },
      cueroCabelludo: { tipo: 'radiactivo' },
    },
  })));

  const c = payload.followUps.at(-1).cosmetologia;
  assert.equal(c.evaluacion.fototipo, '');
  assert.equal(c.evaluacion.deshidratacionFacial, '');
  assert.equal(c.cabello.forma, '');
  assert.equal(c.cabello.longitud, 'corto', 'lo válido sí se guarda');
  assert.equal(c.cueroCabelludo.tipo, '');
});

// ═════════════════ Aislamiento entre especialidades ═════════════════

test('E8) un seguimiento sin ficha de especialidad no inventa datos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'doctor', baseBody()));
  const fu = payload.followUps.at(-1);

  // Mongoose rellena los defaults del esquema, pero TODO debe quedar vacío: es lo
  // que miran los `hasData` del historial para no pintar cajas de más.
  assert.equal(fu.podologia?.hallazgosGenerales?.piel || '', '');
  assert.equal(fu.podologia?.hallazgosGenerales?.edema ?? null, null);
  assert.deepEqual(fu.podologia?.hallazgos || [], []);
  assert.deepEqual(fu.odontologia?.odontograma || [], []);
  assert.equal(fu.odontologia?.observaciones || '', '');
  assert.equal(fu.cosmetologia?.evaluacion?.fototipo || '', '');
  assert.deepEqual(fu.cosmetologia?.evaluacion?.biotipo || [], []);
});

// ═════════════════ Impresión (PDF del seguimiento) ═════════════════

test('E9) el PDF no cambia para quien no llenó ninguna ficha de especialidad', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);
  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'doctor', baseBody()));
  // Con los defaults de mongoose puestos, el bloque debe seguir siendo vacío:
  // así la receta de un doctor general sale byte a byte como antes.
  assert.equal(specialtyFollowUpHtml(payload.followUps.at(-1)), '');
  assert.equal(specialtyFollowUpHtml(null), '');
  assert.equal(specialtyFollowUpHtml({}), '');
});

test('E10) el PDF imprime cada ficha con sus datos y escapa el texto del usuario', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const podo = ok(await postFollowUp(clinicId, userId, patient._id, 'podologia', baseBody({
    podologia: {
      hallazgosGenerales: { piel: 'seca', edema: false },
      vascularNeurologica: { pulsoPedio: 'presente' },
      hallazgos: [{ key: 'onicomicosis', marked: true }],
      hallazgosDetalle: 'Uña <1er> dedo',
    },
  })));
  const htmlPodo = specialtyFollowUpHtml(podo.followUps.at(-1));
  assert.match(htmlPodo, /Ficha podológica/);
  assert.match(htmlPodo, /Hallazgos generales/);
  assert.match(htmlPodo, /Edema:<\/b> No/, 'un "No" explícito sí se imprime');
  assert.match(htmlPodo, /Pulso pedio:<\/b> Presente/);
  assert.match(htmlPodo, /Onicomicosis/);
  assert.match(htmlPodo, /Uña &lt;1er&gt; dedo/, 'el texto del usuario va escapado');
  assert.ok(!htmlPodo.includes('<1er>'), 'nada de HTML crudo del usuario');
  assert.ok(!/Odontograma|cosmetológica/.test(htmlPodo), 'no arrastra otras especialidades');

  const odo = ok(await postFollowUp(clinicId, userId, patient._id, 'odontologia', baseBody({
    odontologia: { odontograma: [{ diente: '36', estado: 'caries', caras: { oclusal: true }, nota: 'profunda' }] },
  })));
  const htmlOdo = specialtyFollowUpHtml(odo.followUps.at(-1));
  assert.match(htmlOdo, /Odontograma \(FDI\)/);
  assert.match(htmlOdo, /<b>36<\/b>/);
  assert.match(htmlOdo, /Caries/);
  assert.match(htmlOdo, /Oclusal/);

  const cosme = ok(await postFollowUp(clinicId, userId, patient._id, 'cosmetologia', baseBody({
    cosmetologia: {
      evaluacion: { fototipo: 'III', hiperpigmentaciones: [{ key: 'tercioMedio', marked: true, derecho: true }] },
      cabello: { forma: 'cinotrico' },
      afeccionesCuero: [{ key: 'alopecia', marked: true, detail: 'androgénica' }],
      procedimiento: { procedimiento: 'Limpieza profunda' },
    },
  })));
  const htmlCosme = specialtyFollowUpHtml(cosme.followUps.at(-1));
  assert.match(htmlCosme, /Ficha cosmetológica/);
  assert.match(htmlCosme, /Fototipo:<\/b> III/);
  assert.match(htmlCosme, /Tercio medio \(D\)/);
  assert.match(htmlCosme, /Forma:<\/b> Cinótrico/, 'la opción se imprime con su etiqueta legible');
  assert.match(htmlCosme, /Alopecia \(indique tipo\): androgénica/);
  assert.match(htmlCosme, /Limpieza profunda/);
});
