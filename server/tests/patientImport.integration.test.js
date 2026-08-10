/**
 * Alta de pacientes: creación desde el modal y CARGA MASIVA por Excel
 * (datos generales + ficha clínica + seguimientos).
 *
 * Cubre el fallo que reportó la clínica: el modal mandaba `referredById: ''`
 * y Mongoose reventaba con un CastError que llegaba al usuario como un
 * "Error al crear paciente" sin explicación.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const ExcelJS = require('exceljs');
const H = require('./_integrationHelpers');

const patients = require('../controllers/patientController');
const patientImport = require('../controllers/patientImportController');
const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

/** Arma un .xlsx en memoria: { NombreHoja: [[fila], [fila]] }. */
async function buildWorkbook(sheets) {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    rows.forEach((r) => ws.addRow(r));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const fileReq = (clinicId, userId, buffer) => {
  const req = H.mockReq(clinicId, userId);
  req.file = { buffer };
  return req;
};

// ─────────────────────────────────────────────────────────────────────────────
test('Alta de paciente — los campos vacíos del modal ya no rompen el guardado', async () => {
  const { clinicId, userId } = await H.seedClinic();

  // Cuerpo tal cual lo enviaba el formulario: todo string, vacíos incluidos.
  const r = await H.runController(patients.createPatient, H.mockReq(clinicId, userId, {
    cedula: '', firstName: 'JUAN', lastName: 'PEREZ', email: '', phone: '0999999999',
    whatsapp: '', birthDate: '', gender: 'masculino', address: '',
    source: '', referredByName: '', referredById: '', referredByType: '',
  }));

  assert.equal(r.statusCode, 201, `esperaba 201 y llegó ${r.statusCode}: ${r.payload?.message}`);
  assert.equal(r.payload.firstName, 'JUAN');
  assert.equal(await Patient.countDocuments({}), 1);
});

test('Alta de paciente — un dato inválido devuelve un mensaje que dice QUÉ falló', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await H.runController(patients.createPatient, H.mockReq(clinicId, userId, {
    firstName: 'ANA', lastName: 'SUAREZ', gender: 'no-existe',
  }));

  assert.equal(r.statusCode, 400);
  // El mensaje debe nombrar el campo, no ser un "Error al crear paciente" seco.
  assert.match(r.payload.message, /gender|género|genero/i);
});

// ─────────────────────────────────────────────────────────────────────────────
test('Carga masiva — crea paciente, ficha clínica y seguimientos enlazados por cédula', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const buffer = await buildWorkbook({
    Pacientes: [
      ['identificacion', 'nombres', 'apellidos', 'genero', 'telefono', 'fecha_nacimiento', 'direccion', 'etiquetas'],
      ['0923456789', 'Ana', 'Suárez', 'femenino', '0991234567', '14/03/1988', 'Av. Principal 123', 'vip; control'],
    ],
    FichaClinica: [
      ['identificacion', 'antecedentes_personales', 'datos_relevantes_personales', 'antecedentes_familiares', 'datos_relevantes_familiares'],
      ['0923456789', 'Hipertensión; Endócrino Metabólico', 'Cesárea 2015', 'Cardiopatía', 'Padre con infarto'],
    ],
    Seguimientos: [
      ['identificacion', 'fecha', 'tipo_consulta', 'motivo_de_consulta', 'enfermedad_actual', 'presion_arterial',
        'frecuencia_cardiaca', 'peso', 'talla', 'revision_de_sistemas', 'hallazgos_revision',
        'examen_fisico_regional', 'examen_fisico_sistemico', 'hallazgos_examen_fisico',
        'diagnosticos_cie10', 'plan_de_tratamiento'],
      ['0923456789', '05/02/2024', 'primera', 'Control de presión', 'Cefalea de 3 días', '140/90',
        82, 68, 162, 'Cardio - vascular; Nervioso', 'Refiere palpitaciones',
        'Cabeza; Cuello', 'Cardio - vascular', 'Ruidos rítmicos sin soplos',
        'I10; G44.2', 'Losartán 50mg c/24h'],
      ['0923456789', '10/03/2024', 'subsecuente', 'Control', '', '130/85', 78, 67.5, 162, '', '', '', '', '', 'I10', 'Continúa tratamiento'],
    ],
  });

  const r = await H.runController(patientImport.importPatients, fileReq(clinicId, userId, buffer));

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.deepEqual(r.payload.errors, [], `errores inesperados: ${r.payload.errors?.join(' | ')}`);
  assert.equal(r.payload.created, 1);
  assert.equal(r.payload.fichas, 1);
  assert.equal(r.payload.seguimientos, 2);

  const p = await Patient.findOne({ cedula: '0923456789' });
  assert.equal(p.firstName, 'ANA');          // el modelo pone los nombres en mayúsculas
  assert.equal(p.gender, 'femenino');
  assert.deepEqual(p.tags, ['vip', 'control']);
  assert.equal(p.birthDate.getFullYear(), 1988);

  const rec = await ClinicalRecord.findOne({ clinic: clinicId, patient: p._id });
  assert.deepEqual(rec.patologicosPersonales.map((c) => c.key), ['hipertension', 'endocrinoMetabolico']);
  assert.deepEqual(rec.patologicosFamiliares.map((c) => c.key), ['cardiopatia']);
  assert.equal(rec.datosRelevantes, 'Cesárea 2015');
  assert.equal(rec.datosRelevantesFamiliares, 'Padre con infarto');

  assert.equal(rec.followUps.length, 2);
  const [fu] = rec.followUps;
  assert.equal(fu.tipoConsulta, 'primera');
  assert.equal(fu.vitalSigns.bloodPressure, '140/90');
  assert.equal(fu.vitalSigns.heartRate, 82);
  assert.deepEqual(fu.revisionSistemas.map((c) => c.key), ['cardioVascular', 'nervioso']);
  assert.deepEqual(fu.examenFisico.regional.map((c) => c.key), ['cabeza', 'cuello']);
  assert.deepEqual(fu.examenFisico.sistemico.map((c) => c.key), ['cardioVascular']);
  assert.equal(fu.revisionSistemasHallazgos, 'Refiere palpitaciones');
  assert.equal(fu.examenFisico.hallazgos, 'Ruidos rítmicos sin soplos');
  // Los CIE-10 traen su descripción oficial desde el catálogo del sistema.
  assert.equal(fu.diagnosticos.length, 2);
  assert.equal(fu.diagnosticos[0].cie, 'I10');
  assert.match(fu.diagnosticos[0].cieDescripcion, /Hipertensión esencial/i);
});

test('Carga masiva — la segunda subida actualiza al paciente en vez de duplicarlo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const sheet = (phone) => ({
    Pacientes: [
      ['identificacion', 'nombres', 'apellidos', 'genero', 'telefono'],
      ['0923456789', 'Ana', 'Suárez', 'femenino', phone],
    ],
  });

  await H.runController(patientImport.importPatients, fileReq(clinicId, userId, await buildWorkbook(sheet('0991111111'))));
  const r2 = await H.runController(patientImport.importPatients, fileReq(clinicId, userId, await buildWorkbook(sheet('0992222222'))));

  assert.equal(r2.payload.created, 0);
  assert.equal(r2.payload.updated, 1);
  assert.equal(await Patient.countDocuments({}), 1);
  assert.equal((await Patient.findOne({ cedula: '0923456789' })).phone, '0992222222');
});

test('Carga masiva — enlaza por nombre cuando el paciente no tiene identificación', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const buffer = await buildWorkbook({
    Pacientes: [
      ['identificacion', 'nombres', 'apellidos', 'genero'],
      ['', 'Luis', 'Mora', 'masculino'],
    ],
    Seguimientos: [
      ['identificacion', 'nombres', 'apellidos', 'fecha', 'motivo_de_consulta'],
      ['', 'Luis', 'Mora', '01/06/2024', 'Chequeo general'],
    ],
  });

  const r = await H.runController(patientImport.importPatients, fileReq(clinicId, userId, buffer));

  assert.deepEqual(r.payload.errors, []);
  assert.equal(r.payload.seguimientos, 1);
  const p = await Patient.findOne({ firstName: 'LUIS' });
  const rec = await ClinicalRecord.findOne({ patient: p._id });
  assert.equal(rec.followUps[0].descripcion, 'Chequeo general');
});

test('Carga masiva — reporta por fila lo que no pudo importar', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const buffer = await buildWorkbook({
    Pacientes: [
      ['identificacion', 'nombres', 'apellidos', 'genero'],
      ['0911111111', 'Sin', 'Genero', ''],              // género inválido
      ['0922222222', '', 'Apellido', 'masculino'],       // sin nombres
      ['0933333333', 'Ok', 'Valido', 'masculino'],
    ],
    Seguimientos: [
      ['identificacion', 'fecha', 'motivo_de_consulta', 'revision_de_sistemas'],
      ['0999999999', '01/06/2024', 'Consulta', ''],      // paciente inexistente
      ['0933333333', '', 'Sin fecha', ''],               // sin fecha
      ['0933333333', '01/06/2024', 'Consulta', 'Inventado'], // check fuera del catálogo
    ],
  });

  const r = await H.runController(patientImport.importPatients, fileReq(clinicId, userId, buffer));

  assert.equal(r.payload.created, 1);
  assert.equal(r.payload.seguimientos, 1);
  assert.equal(r.payload.errors.length, 4);
  assert.ok(r.payload.errors.some((e) => /genero/i.test(e)));
  assert.ok(r.payload.errors.some((e) => /nombres y apellidos/i.test(e)));
  assert.ok(r.payload.errors.some((e) => /no se encontró el paciente/i.test(e)));
  assert.ok(r.payload.errors.some((e) => /fecha/i.test(e)));
  assert.ok(r.payload.warnings.some((w) => /Inventado/.test(w)));
});

test('Carga masiva — la plantilla que descarga el usuario se importa tal cual (sin tocarla)', async () => {
  const { clinicId, userId } = await H.seedClinic();

  // `downloadTemplate` escribe el .xlsx en el stream de la respuesta.
  const { PassThrough } = require('node:stream');
  const chunks = [];
  const res = new PassThrough();
  res.on('data', (c) => chunks.push(c));
  res.setHeader = () => res;
  res.status = () => res;
  res.json = () => res;
  const finished = new Promise((resolve) => res.on('end', resolve));
  await patientImport.downloadTemplate(H.mockReq(clinicId, userId), res);
  await finished;

  // Se sube la plantilla con su fila de ejemplo, sin modificar nada.
  const r = await H.runController(patientImport.importPatients, fileReq(clinicId, userId, Buffer.concat(chunks)));

  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.deepEqual(r.payload.errors, [], `la plantilla oficial no debería dar errores: ${r.payload.errors?.join(' | ')}`);
  assert.equal(r.payload.created, 1);
  assert.equal(r.payload.fichas, 1);
  assert.equal(r.payload.seguimientos, 1);
  // Y los datos del ejemplo llegan completos (encabezados ↔ alias del importador).
  const rec = await ClinicalRecord.findOne({});
  assert.ok(rec.patologicosPersonales.length > 0, 'los antecedentes del ejemplo no se mapearon');
  assert.ok(rec.followUps[0].diagnosticos.length > 0, 'los diagnósticos del ejemplo no se mapearon');
  assert.equal(rec.followUps[0].vitalSigns.bloodPressure, '140/90');
});

test('Carga masiva — un archivo sin las hojas de la plantilla se rechaza con instrucciones', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const buffer = await buildWorkbook({ Hoja1: [['cualquier', 'cosa'], ['a', 'b']] });

  const r = await H.runController(patientImport.importPatients, fileReq(clinicId, userId, buffer));

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /plantilla oficial/i);
});
