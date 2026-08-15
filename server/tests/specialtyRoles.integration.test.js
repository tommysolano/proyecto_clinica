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
  // Formato ANTIGUO (`caras` booleanas): un `true` hereda el estado de la pieza,
  // así lo ya registrado se sigue leyendo tras pasar las caras a estado propio.
  assert.equal(o.odontograma[1].caras.oclusal, 'caries');
  assert.equal(o.odontograma[1].nota, 'profunda');
  assert.equal(o.observaciones, 'Revisar en 6 meses');
  assert.ok(!ODONTOGRAMA_PIEZAS.includes('99'), 'la 99 no existe en FDI');
});

test('E5b) cada cara guarda SU estado: caries en una y obturado en otra del mismo diente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'odontologia', baseBody({
    odontologia: {
      odontograma: [
        {
          diente: '46',
          estado: 'endodoncia',
          caras: {
            oclusal: 'caries',
            mesial: 'obturado',
            distal: 'extraccionIndicada', // símbolo de PIEZA: no vale para una cara
            vestibular: 'no_existe',
          },
          recesion: '2',
          movilidad: '9',                 // fuera de 1-3
        },
      ],
    },
  })));

  const d = payload.followUps.at(-1).odontologia.odontograma[0];
  assert.equal(d.caras.oclusal, 'caries');
  assert.equal(d.caras.mesial, 'obturado', 'dos caras distintas, dos estados distintos');
  assert.equal(d.caras.distal, '', 'un símbolo de pieza entera no se pinta en una cara');
  assert.equal(d.caras.vestibular, '');
  assert.equal(d.estado, 'endodoncia', 'el símbolo de la pieza sí se guarda');
  assert.equal(d.recesion, '2');
  assert.equal(d.movilidad, '', 'el grado solo admite 1, 2 ó 3');
});

test('E5d) una cara del formato viejo NUNCA inventa un diagnóstico', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  // Formato antiguo: caras booleanas. El estado de la pieza NO es de cara, así que
  // la cara no puede heredarlo. Antes se rellenaba con 'caries': eso escribía en la
  // historia clínica un diagnóstico que el odontólogo nunca puso.
  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'odontologia', baseBody({
    odontologia: {
      odontograma: [
        { diente: '38', estado: 'extraccionIndicada', caras: { vestibular: true } },
        { diente: '33', estado: 'ausente', caras: { mesial: true } },
        { diente: '37', estado: '', caras: { oclusal: true } },
        // Este sí puede heredar: 'obturado' es un estado de cara.
        { diente: '16', estado: 'obturado', caras: { distal: true } },
      ],
    },
  })));

  const byD = Object.fromEntries(payload.followUps.at(-1).odontologia.odontograma.map((d) => [d.diente, d]));
  assert.equal(byD['38'].caras.vestibular, '', 'un diente por extraer no tiene caries inventada');
  assert.equal(byD['38'].estado, 'extraccionIndicada', 'el símbolo de la pieza sí se conserva');
  assert.equal(byD['33'].caras.mesial, '', 'un diente AUSENTE no puede tener caries');
  // La 37 venía sin estado de pieza: no hay nada que heredar, la cara queda vacía
  // y la pieza entera deja de tener contenido, así que ni siquiera se guarda.
  assert.equal(byD['37'], undefined, 'una pieza que se queda sin nada no se guarda');
  assert.equal(byD['16'].caras.distal, 'obturado', 'lo que sí es estado de cara se hereda');
});

test('E5c) indicadores de salud bucal e índices CPO-ceo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'odontologia', baseBody({
    odontologia: {
      higieneOral: [
        { fila: 'sup_ant', pieza: '11', placa: '2', calculo: '1', gingivitis: '1' },
        { fila: 'sup_der', pieza: '99', placa: '7', calculo: '3', gingivitis: '0' }, // pieza y placa inválidas
        { fila: 'fila_inventada', pieza: '16', placa: '1' },                          // sextante inexistente
        { fila: 'inf_der' },                                                          // vacía: no aporta
      ],
      enfermedadPeriodontal: 'moderada',
      maloclusion: 'angleII',
      fluorosis: 'inventada',
      cpo: { c: '3', p: '1', o: '4' },
      ceo: { c: '2', e: '0', o: '99999' },
    },
  })));

  const o = payload.followUps.at(-1).odontologia;
  assert.deepEqual(o.higieneOral.map((f) => f.fila), ['sup_der', 'sup_ant'], 'en el orden de la hoja');
  const supDer = o.higieneOral.find((f) => f.fila === 'sup_der');
  assert.equal(supDer.pieza, '', 'la 99 no es una de las tres piezas de ese sextante');
  assert.equal(supDer.placa, '', 'la placa solo llega a 3');
  assert.equal(supDer.calculo, '3');
  assert.equal(o.enfermedadPeriodontal, 'moderada');
  assert.equal(o.maloclusion, 'angleII');
  assert.equal(o.fluorosis, '', 'fuera de catálogo se descarta');
  assert.deepEqual({ ...o.cpo.toObject?.() || o.cpo }, { c: '3', p: '1', o: '4' });
  assert.equal(o.ceo.o, '', 'un conteo imposible de piezas no se guarda');
  assert.equal(o.ceo.e, '0', 'un cero SÍ es un dato: paciente sin piezas en ese índice');
});

test('E5e) un conteo mal tecleado no se guarda a medias', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId, userId);

  const payload = ok(await postFollowUp(clinicId, userId, patient._id, 'odontologia', baseBody({
    // '3.9' se guardaba como 3 y '5abc' como 5: el conteo quedaba distinto del que
    // se digitó, sin ningún aviso.
    odontologia: { cpo: { c: '3.9', p: '5abc', o: ' 4 ' }, ceo: { c: '-2', e: '', o: '07' } },
  })));

  const o = payload.followUps.at(-1).odontologia;
  assert.equal(o.cpo.c, '', 'un decimal no es un conteo de piezas');
  assert.equal(o.cpo.p, '', 'ni un número con letras pegadas');
  assert.equal(o.cpo.o, '4', 'los espacios sí se toleran');
  assert.equal(o.ceo.c, '', 'no hay conteos negativos');
  assert.equal(o.ceo.o, '7', 'se normaliza sin el cero de delante');
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
