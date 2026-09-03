/**
 * IMPORTAR PACIENTES DESDE FICHAS ESCANEADAS (scripts/importPatientsFromScans.js).
 *
 * El script crea pacientes reales a partir de una transcripción hecha a mano de
 * letra manuscrita, así que lo que hay que demostrar no es que crea pacientes
 * —eso es lo fácil— sino sus tres garantías:
 *
 *   · El ESCÁNER queda intacto. El PDF original es la única prueba de lo que
 *     decía la ficha; si la importación lo moviera o lo alterara, el dato dudoso
 *     ya no se podría contrastar contra nada.
 *   · NO dispara automatizaciones. Importar 114 pacientes antiguos de golpe no
 *     puede desatar una tanda de mensajes de bienvenida.
 *   · Se puede repetir. Un fallo a mitad no deja pacientes a medias ni duplica
 *     a nadie al reintentar.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const H = require('./_integrationHelpers');

const { importarFichas, NOTA_SEGUIMIENTO } = require('../scripts/importPatientsFromScans');

const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const ScannedDocument = require('../models/ScannedDocument');
const PatientObservation = require('../models/PatientObservation');
const { pdfDePaginas } = require('../utils/scanMedia');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const Conversation = require('../models/Conversation');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });

let dirs;
let raiz;

test.beforeEach(async () => {
  await H.resetDb();
  raiz = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiluv-scans-test-'));
  dirs = {
    scans: path.join(raiz, 'scans'),
    followups: path.join(raiz, 'followups'),
    observations: path.join(raiz, 'observations'),
  };
});

test.afterEach(async () => {
  await fsp.rm(raiz, { recursive: true, force: true }).catch(() => {});
});

/** Contenido reconocible: sirve para probar que la copia es fiel al original. */
const CONTENIDO_PDF = Buffer.from('%PDF-1.4 ficha fisica de prueba');

/**
 * Un JPEG de 1×1 de verdad. Hace falta uno auténtico porque el PDF de las fichas
 * se arma con pdfkit, que lee las marcas del JPEG para incrustarlo.
 */
const JPEG_1x1 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
    'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA' +
    'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
  'base64'
);

/**
 * Crea el ScannedDocument y deja su PDF en disco, como lo dejaría el escáner.
 *
 * Con `paginas` se arma un PDF DE VERDAD (una foto por página, igual que
 * scanController): es lo único que permite probar que la ÚLTIMA página acaba en
 * las observaciones del paciente.
 */
async function seedEscaneo(
  clinicId,
  userId,
  { name = 'Ficha Jose Cuzco', createdAt = new Date('2026-06-10T15:00:00'), paginas = 0 } = {}
) {
  const contenido = paginas
    ? await pdfDePaginas(Array.from({ length: paginas }, () => JPEG_1x1), name)
    : CONTENIDO_PDF;
  const filename = `${name.replace(/\s+/g, '_')}.pdf`;
  const dir = path.join(dirs.scans, String(clinicId));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, filename), contenido);

  const doc = await ScannedDocument.create({
    clinic: clinicId,
    name,
    nameKey: name.toLowerCase(),
    filename,
    size: contenido.length,
    pages: paginas || 1,
    createdBy: userId,
  });
  // `createdAt` lo pone mongoose con timestamps; para probar el respaldo de fecha
  // hay que forzarlo (un $set directo: mongoose ignora createdAt en un save normal).
  await ScannedDocument.collection.updateOne({ _id: doc._id }, { $set: { createdAt } });
  return ScannedDocument.findById(doc._id);
}

/** Ficha transcrita, bien leída. */
const fichaBuena = (documento = 'Ficha Jose Cuzco', extra = {}) => ({
  documento,
  fecha: '1-06-26',
  nombres: 'José',
  apellidos: 'Cuzco Espinoza',
  cedula: '0905103495',
  edad: '71',
  celular: '0994967491',
  correo: 'josecuzco@gmail.com',
  direccion: 'Barrio Garay',
  dudosos: [],
  ...extra,
});

/**
 * Reductor de mentira: devuelve la foto tal cual.
 *
 * El de verdad abre un Chromium para reescalar (utils/scanMedia.js) y aquí no
 * pinta nada: lo que se prueba es el FLUJO —a quién se le cuelga cada cosa y qué
 * no se duplica—, no la calidad de un JPEG.
 */
const reductorFalso = { reducir: async (b) => b };

const importar = (fichas, opts = {}) =>
  importarFichas({ fichas, commit: true, dirs, reductor: reductorFalso, ...opts });

// ───────────────────────── Creación ─────────────────────────

test('I1) una ficha legible crea paciente, historia y seguimiento con el PDF adjunto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const doc = await seedEscaneo(clinicId, userId);

  const r = await importar([fichaBuena()]);
  assert.equal(r.errores.length, 0, JSON.stringify(r.errores));
  assert.equal(r.creados.length, 1);

  const p = await Patient.findOne({ cedula: '0905103495' });
  assert.ok(p, 'el paciente se creó');
  assert.equal(p.firstName, 'JOSÉ', 'el modelo guarda el nombre en mayúsculas');
  assert.equal(p.lastName, 'CUZCO ESPINOZA');
  assert.equal(p.age, 71);
  assert.equal(p.phone, '0994967491');
  assert.equal(p.email, 'josecuzco@gmail.com');
  assert.equal(p.address, 'Barrio Garay');
  assert.equal(String(p.scanImport.scan), String(doc._id), 'queda enlazado a su escaneo');
  assert.deepEqual(p.scanImport.dudas, [], 'nada que revisar');

  const rec = await ClinicalRecord.findOne({ patient: p._id });
  assert.ok(rec, 'se creó la ficha clínica');
  assert.equal(rec.followUps.length, 1);

  const fu = rec.followUps[0];
  assert.equal(fu.observaciones, NOTA_SEGUIMIENTO);
  assert.equal(fu.attachments.length, 1, 'el doctor tiene el PDF a mano');
  assert.equal(fu.attachments[0].mimeType, 'application/pdf');
  assert.equal(
    fu.attachments[0].originalName,
    'Ficha Jose Cuzco - ficha.pdf',
    'el seguimiento lleva la PRIMERA página: la ficha de registro'
  );
  assert.equal(fu.attachments[0].size, CONTENIDO_PDF.length);
});

test('I2) manda la fecha ESCRITA en la ficha, no la del día que se escaneó', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { createdAt: new Date('2026-08-14T10:00:00') });

  await importar([fichaBuena()]);

  const p = await Patient.findOne({ cedula: '0905103495' });
  const rec = await ClinicalRecord.findOne({ patient: p._id });
  // La ficha dice "1-06-26": 1 de junio, aunque se escaneara en agosto.
  assert.equal(rec.fecha.getMonth(), 5, 'junio');
  assert.equal(rec.fecha.getDate(), 1);
  assert.equal(rec.followUps[0].fecha.getMonth(), 5, 'el seguimiento lleva la misma fecha');
  assert.equal(rec.followUps[0].fecha.getDate(), 1);
});

test('I3) sin fecha legible usa la del escaneo y lo deja marcado para revisar', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { createdAt: new Date('2026-08-14T10:00:00') });

  await importar([fichaBuena('Ficha Jose Cuzco', { fecha: '' })]);

  const p = await Patient.findOne({ cedula: '0905103495' });
  const rec = await ClinicalRecord.findOne({ patient: p._id });
  assert.equal(rec.fecha.getMonth(), 7, 'agosto: la fecha del escaneo como respaldo');
  assert.ok(p.scanImport.dudas.includes('fecha'), 'no se da por buena: se marca');
});

// ───────────────── El escáner no se toca ─────────────────

test('I4) el PDF original sigue intacto en el escáner y el adjunto es una copia', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const doc = await seedEscaneo(clinicId, userId);
  const original = path.join(dirs.scans, String(clinicId), doc.filename);

  await importar([fichaBuena()]);

  // El original: mismo archivo, mismo contenido, y su ficha sigue en la base.
  assert.deepEqual(await fsp.readFile(original), CONTENIDO_PDF, 'el original no se alteró');
  assert.ok(await ScannedDocument.findById(doc._id), 'el documento sigue en /scanner');

  // La copia: archivo distinto, contenido idéntico.
  const p = await Patient.findOne({ cedula: '0905103495' });
  const rec = await ClinicalRecord.findOne({ patient: p._id });
  const copia = path.join(dirs.followups, String(clinicId), rec.followUps[0].attachments[0].filename);
  assert.notEqual(copia, original, 'es una copia, no el mismo archivo');
  assert.deepEqual(await fsp.readFile(copia), CONTENIDO_PDF, 'la copia es fiel');
});

// ───────────────── No dispara automatizaciones ─────────────────

test('I5) importar un lote NO inscribe a nadie en las automatizaciones', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);

  // Una automatización ACTIVA que reacciona justo al alta de pacientes.
  await Workflow.create({
    clinic: clinicId,
    name: 'Bienvenida al nuevo paciente',
    active: true,
    trigger: { type: 'patient_created' },
  });

  await importar([fichaBuena()]);

  assert.ok(await Patient.findOne({ cedula: '0905103495' }), 'el paciente sí se creó');
  assert.equal(
    await WorkflowEnrollment.countDocuments({}),
    0,
    'importar pacientes antiguos no puede desatar mensajes de bienvenida'
  );
});

// ───────────────── Repetible y sin duplicados ─────────────────

test('I6) correr el importador dos veces no duplica al paciente ni su seguimiento', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);

  await importar([fichaBuena()]);
  const segunda = await importar([fichaBuena()]);

  assert.equal(segunda.creados.length, 0, 'no da de alta a nadie más');
  assert.equal(segunda.fusionados.length, 1, 'reconoce que esa ficha ya era suya');
  assert.equal(segunda.fusionados[0].seguimiento, false, 'no vuelve a colgarle el documento');
  assert.equal(await Patient.countDocuments({}), 1);
  assert.equal(await ClinicalRecord.countDocuments({}), 1);

  const rec = await ClinicalRecord.findOne({});
  assert.equal(rec.followUps.length, 1, 'un solo seguimiento, no dos con el mismo PDF');
});

test('I7) si la cédula ya existe, la ficha se le cuelga a ESE paciente en vez de crear otro', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);
  const previo = await Patient.create({ clinic: clinicId, cedula: '0905103495', firstName: 'Jose', lastName: 'Cuzco' });

  const r = await importar([fichaBuena()]);

  assert.equal(r.errores.length, 0, 'un duplicado esperado no es un error técnico');
  assert.equal(r.creados.length, 0);
  assert.equal(r.fusionados.length, 1);
  assert.equal(await Patient.countDocuments({}), 1, 'no se creó un segundo registro');

  // Lo que aporta la ficha no se pierde por ser de alguien que ya estaba.
  const rec = await ClinicalRecord.findOne({ patient: previo._id });
  assert.ok(rec, 'al paciente que ya existía se le abre su historia');
  assert.equal(rec.followUps.length, 1);
  assert.equal(rec.followUps[0].attachments[0].originalName, 'Ficha Jose Cuzco - ficha.pdf');
});

test('I8) dos fichas de la misma persona dan UN paciente con los dos documentos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { name: 'Ficha A' });
  await seedEscaneo(clinicId, userId, { name: 'Ficha B' });

  const r = await importar([fichaBuena('Ficha A'), fichaBuena('Ficha B')]);

  assert.equal(r.creados.length, 1, 'la segunda hoja es del mismo señor');
  assert.equal(r.fusionados.length, 1);
  assert.equal(await Patient.countDocuments({}), 1);

  const rec = await ClinicalRecord.findOne({});
  assert.equal(rec.followUps.length, 2, 'pero sus dos hojas quedan en la historia');
  assert.deepEqual(
    rec.followUps.map((f) => f.attachments[0].originalName).sort(),
    ['Ficha A - ficha.pdf', 'Ficha B - ficha.pdf']
  );
});

test('I9) si el PDF no está en disco no se crea un paciente sin su respaldo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const doc = await seedEscaneo(clinicId, userId);
  await fsp.unlink(path.join(dirs.scans, String(clinicId), doc.filename));

  const r = await importar([fichaBuena()]);

  assert.equal(r.creados.length, 0);
  assert.equal(r.errores.length, 1);
  assert.equal(await Patient.countDocuments({}), 0, 'nada a medias: ni paciente huérfano');
  assert.equal(await ClinicalRecord.countDocuments({}), 0);
});

// ───────────────── Dudas y revisión ─────────────────

test('I10) los campos dudosos quedan registrados junto a lo que se leyó', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);

  await importar([fichaBuena('Ficha Jose Cuzco', {
    cedula: '0905103496',       // 10 dígitos pero el verificador no cuadra
    celular: '12345',           // no puede ser un teléfono
    dudosos: ['direccion'],     // además, la dirección se leyó con dificultad
  })]);

  const p = await Patient.findOne({ 'scanImport.scan': { $ne: null } });
  assert.ok(p.scanImport.dudas.includes('cedula'));
  assert.ok(p.scanImport.dudas.includes('celular'));
  assert.ok(p.scanImport.dudas.includes('direccion'), 'se respeta la duda de quien transcribió');
  assert.equal(p.cedula, '0905103496', 'la cédula se conserva aunque esté marcada');
  assert.equal(p.phone, '', 'un teléfono imposible no se guarda');
  assert.equal(p.scanImport.crudo.celular, '12345', 'lo leído se guarda para comparar con el PDF');
  assert.equal(p.scanImport.revisadoAt, null, 'nace pendiente de revisión');
});

test('I11) una ficha sin nombre legible no crea un paciente anónimo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);

  const r = await importar([fichaBuena('Ficha Jose Cuzco', { nombres: '', apellidos: '' })]);

  assert.equal(r.creados.length, 0);
  assert.match(r.omitidos[0].motivo, /nombre ni apellido/);
  assert.equal(await Patient.countDocuments({}), 0);
});

// ───────────────── Emparejado y dry-run ─────────────────

test('I12) una entrada que no casa con ningún escaneo se reporta, no se adivina', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { name: 'Ficha Jose Cuzco' });

  const r = await importar([fichaBuena('Ficha Que No Existe')]);

  assert.equal(r.creados.length, 0);
  assert.equal(r.errores.length, 1);
  assert.match(r.errores[0].motivo, /no hay ningún escaneo/);
});

test('I13) el nombre casa aunque cambien tildes, mayúsculas o espacios', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { name: 'Ficha José Cuzco' });

  const r = await importar([fichaBuena('  ficha jose  cuzco ')]);

  assert.equal(r.errores.length, 0, JSON.stringify(r.errores));
  assert.equal(r.creados.length, 1);
});

test('I14) el dry-run informa lo que haría sin escribir nada, ni en la base ni en disco', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);

  const r = await importarFichas({ fichas: [fichaBuena()], commit: false, dirs });

  assert.equal(r.creados.length, 1, 'informa que crearía uno');
  assert.equal(await Patient.countDocuments({}), 0, 'pero no lo creó');
  assert.equal(await ClinicalRecord.countDocuments({}), 0);
  await assert.rejects(
    () => fsp.readdir(path.join(dirs.followups, String(clinicId))),
    'tampoco copió ningún PDF'
  );
});

// ───────────────── Marca de una sola vez (despliegue) ─────────────────

test('I15) con la marca puesta, un segundo despliegue NO resucita a un paciente borrado', async () => {
  const os = require('os');
  const { runOnce } = require('../scripts/importPatientsFromScans');
  const OneTimeTask = require('../models/OneTimeTask');

  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);

  // El JSON que leería el despliegue.
  const datos = path.join(raiz, 'fichas.json');
  await fsp.writeFile(datos, JSON.stringify({ fichas: [fichaBuena()] }));

  // La idempotencia por escaneo ya evita duplicar, pero NO cubre este caso: si el
  // paciente se borra a mano, sin marca el siguiente push lo volvería a crear.
  const primera = await runOnce({ key: 'test-fichas', ruta: datos, dirs, log: () => {} });
  assert.equal(primera.status, 'DONE');
  assert.equal(primera.result.creados, 1);

  await Patient.deleteMany({});
  assert.equal(await Patient.countDocuments({}), 0);

  const segunda = await runOnce({ key: 'test-fichas', ruta: datos, dirs, log: () => {} });
  assert.equal(segunda.skipped, true, 'la marca la detiene');
  assert.equal(await Patient.countDocuments({}), 0, 'el paciente borrado sigue borrado');

  const marca = await OneTimeTask.findById('test-fichas').lean();
  assert.equal(marca.status, 'DONE');
  assert.equal(marca.host, os.hostname(), 'consta dónde corrió');
});

// ───────────────── Fichas sin cédula (el formulario nuevo) ─────────────────

test('I16) sin cédula, la misma persona con el mismo celular no se da de alta dos veces', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { name: 'Hoja 1' });
  await seedEscaneo(clinicId, userId, { name: 'Hoja 2' });

  // El formulario nuevo no tiene casilla de cédula, y quien vuelve llena otra hoja.
  // Además el orden de nombre y apellidos cambia según quién transcriba.
  const r = await importar([
    fichaBuena('Hoja 1', { cedula: '', nombres: 'Ismenia', apellidos: 'Santillán Cedeño', celular: '0986437282' }),
    fichaBuena('Hoja 2', { cedula: '', nombres: 'Santillan Cedeno', apellidos: 'ISMENIA', celular: '0986437282' }),
  ]);

  assert.equal(r.errores.length, 0, JSON.stringify(r.errores));
  assert.equal(r.creados.length, 1);
  assert.equal(r.fusionados.length, 1);
  assert.equal(await Patient.countDocuments({}), 1);
});

test('I17) mismo nombre y otro celular: es la misma persona, y se guardan los dos números', async () => {
  // El celular de la segunda hoja está mal leído (un dígito), que es lo que pasa
  // de verdad. Antes esto daba de alta un duplicado; ahora se reconoce por el
  // nombre, no se pisa el teléfono bueno y el otro queda a la vista.
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { name: 'Hoja 1' });
  await seedEscaneo(clinicId, userId, { name: 'Hoja 2' });

  const r = await importar([
    fichaBuena('Hoja 1', { cedula: '', nombres: 'María', apellidos: 'Pérez', celular: '0991111111' }),
    fichaBuena('Hoja 2', { cedula: '', nombres: 'María', apellidos: 'Pérez', celular: '0992222222' }),
  ]);

  assert.equal(r.creados.length, 1);
  assert.equal(r.fusionados.length, 1);
  assert.equal(await Patient.countDocuments({}), 1, 'una sola María Pérez');

  const p = await Patient.findOne({ firstName: 'MARÍA' });
  assert.equal(p.phone, '0991111111', 'el primero manda: no se pisa');
  const otro = p.scanImport.alternos.find((a) => a.campo === 'celular');
  assert.ok(otro, 'el número de la otra hoja no se tira');
  assert.equal(otro.valor, '0992222222');
  assert.ok(p.scanImport.dudas.includes('celular'), 'y queda marcado para revisarlo');
  assert.equal(p.scanImport.revisadoAt, null, 'vuelve a la lista de pendientes');
});

test('I17b) si en la base YA hay dos pacientes con ese nombre, la ficha se aparta', async () => {
  // Aquí el nombre no identifica a nadie: meterla en la historia de la que no es
  // no lo detecta nadie a simple vista, así que no se elige por sorteo.
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { name: 'Hoja 1' });
  await Patient.create({ clinic: clinicId, firstName: 'María', lastName: 'Pérez', phone: '0993333333' });
  await Patient.create({ clinic: clinicId, firstName: 'María', lastName: 'Pérez', phone: '0994444444' });

  const r = await importar([
    fichaBuena('Hoja 1', { cedula: '', nombres: 'María', apellidos: 'Pérez', celular: '0991111111' }),
  ]);

  assert.equal(r.creados.length, 0, 'ni se inventa una tercera');
  assert.equal(r.fusionados.length, 0, 'ni se le cuelga a una de las dos');
  assert.equal(r.omitidos.length, 1);
  assert.match(r.omitidos[0].motivo, /más de un paciente/);
  assert.equal(await Patient.countDocuments({}), 2);
});

// ───────────────── Las hojas de seguimiento (observaciones) ─────────────────

test('I18) la ficha va al seguimiento y el RESTO de páginas a observaciones', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const doc = await seedEscaneo(clinicId, userId, { paginas: 3 });

  const r = await importar([fichaBuena()]);
  assert.equal(r.errores.length, 0, JSON.stringify(r.errores));
  assert.equal(r.creados[0].observacion, true);

  const p = await Patient.findOne({ cedula: '0905103495' });
  const obs = await PatientObservation.findOne({ patient: p._id });
  assert.ok(obs, 'la observación se creó');
  assert.equal(String(obs.scanImport.scan), String(doc._id), 'queda enlazada a su escaneo');
  assert.equal(String(obs.createdBy), String(userId), 'la firma quien escaneó');
  assert.match(obs.text, /2 hojas de seguimiento/, 'dice cuántas hojas trae');
  assert.match(obs.text, /primer seguimiento/, 'y dónde quedó la ficha de registro');
  assert.match(obs.text, /Ficha Jose Cuzco/, 'dice dónde está el original por si hace falta el detalle');

  assert.equal(obs.attachments.length, 1, 'todas las hojas en UN archivo, en orden');
  assert.equal(obs.attachments[0].mimeType, 'application/pdf');
  assert.match(obs.attachments[0].originalName, /hojas de seguimiento/);

  // El archivo está donde lo busca patientObservationController: por PACIENTE.
  const enDisco = await fsp.readFile(
    path.join(dirs.observations, String(p._id), obs.attachments[0].filename)
  );
  assert.equal(enDisco.length, obs.attachments[0].size);
});

test('I19) reimportar no le cuelga al paciente la misma hoja dos veces', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { paginas: 2 });

  await importar([fichaBuena()]);
  const segunda = await importar([fichaBuena()]);

  assert.equal(segunda.fusionados[0].observacion, false);
  assert.equal(await PatientObservation.countDocuments({}), 1);
});

test('I20) un escaneo de una sola página no inventa una hoja de seguimiento', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { paginas: 1 });

  const r = await importar([fichaBuena()]);

  assert.equal(r.creados[0].observacion, false);
  assert.match(r.creados[0].sinHoja, /una sola página/);
  assert.equal(await PatientObservation.countDocuments({}), 0, 'la ficha no es su propia hoja de seguimiento');
});

test('I21) la observación es del paciente que ya existía, no de uno nuevo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { paginas: 2 });
  const previo = await Patient.create({ clinic: clinicId, cedula: '0905103495', firstName: 'Jose', lastName: 'Cuzco' });

  const r = await importar([fichaBuena()]);

  assert.equal(r.fusionados.length, 1);
  const obs = await PatientObservation.findOne({});
  assert.equal(String(obs.patient), String(previo._id));
});

// ───────── El paciente que ya existe: completar sin pisar ─────────
//
// Casi todos los pacientes de esta tanda YA estaban (vinieron de Contífico, con
// la cédula y el teléfono tecleados por una persona). La ficha es letra
// manuscrita transcrita a ojo: si pisara, degradaría datos buenos.

test('I22) al paciente que ya existía se le COMPLETA lo que tiene vacío', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);
  const previo = await Patient.create({
    clinic: clinicId, cedula: '0905103495', firstName: 'Jose', lastName: 'Cuzco',
    phone: '0994967491', // el bueno, tecleado
  });

  await importar([fichaBuena()]);

  const p = await Patient.findById(previo._id);
  assert.equal(p.age, 71, 'la edad la aporta la ficha: Contífico no la trae');
  assert.equal(p.address, 'Barrio Garay');
  assert.equal(p.email, 'josecuzco@gmail.com');
  assert.equal(p.phone, '0994967491', 'lo que ya tenía sigue igual');
  assert.deepEqual(p.scanImport.alternos, [], 'no había nada que difiriera');
});

test('I23) lo que DIFIERE no se pisa: se guardan los dos valores', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);
  const previo = await Patient.create({
    clinic: clinicId,
    cedula: '0905103495',
    firstName: 'Jose', lastName: 'Cuzco',
    phone: '0994967491',
    email: 'jose.cuzco@empresa.com',
    address: 'Barrio Garay',
  });

  // La misma persona (casa por cédula) con el celular y el correo mal leídos.
  await importar([fichaBuena('Ficha Jose Cuzco', {
    celular: '0994967490',
    correo: 'josecuzco@gmail.com',
    direccion: 'BARRIO GARAY',
  })]);

  const p = await Patient.findById(previo._id);
  assert.equal(p.phone, '0994967491', 'el del sistema manda');
  assert.equal(p.email, 'jose.cuzco@empresa.com');

  const campos = p.scanImport.alternos.map((a) => a.campo).sort();
  assert.deepEqual(campos, ['celular', 'correo'], 'y el papel queda guardado, no tirado');
  assert.equal(p.scanImport.alternos.find((a) => a.campo === 'celular').valor, '0994967490');
  assert.ok(
    p.scanImport.alternos.every((a) => a.scan),
    'cada valor dice de qué escaneo salió, para poder abrir ESE PDF'
  );
  assert.ok(p.scanImport.dudas.includes('celular') && p.scanImport.dudas.includes('correo'));
  // "BARRIO GARAY" y "Barrio Garay" son lo mismo: comparar en crudo llenaría la
  // pantalla de revisión de diferencias que no lo son.
  assert.ok(!campos.includes('direccion'), 'mayúsculas y tildes no son una discrepancia');
});

test('I24) una cédula que ya es de otro paciente no se escribe: se guarda aparte', async () => {
  // La cédula es clave ÚNICA en toda la base. Si se escribiera a ciegas, el E11000
  // tumbaría la ficha entera por un dígito mal leído. El caso llega por reintento:
  // esta ficha ya creó a su paciente (sin cédula) y, entre medias, esa cédula pasó
  // a ser de otro.
  const { clinicId, userId } = await H.seedClinic();
  const doc = await seedEscaneo(clinicId, userId);
  await Patient.create({ clinic: clinicId, cedula: '0905103495', firstName: 'Otro', lastName: 'Señor' });
  const suyo = await Patient.create({
    clinic: clinicId,
    firstName: 'José', lastName: 'Cuzco Espinoza', phone: '0994967491',
    scanImport: { scan: doc._id, importadoAt: new Date() },
  });

  const r = await importar([fichaBuena()]);

  assert.equal(r.errores.length, 0, 'un choque de cédula no tumba la ficha');
  const p = await Patient.findById(suyo._id);
  assert.equal(p.cedula || '', '', 'no se le pone la cédula de otro');
  assert.equal(p.scanImport.alternos.find((a) => a.campo === 'cedula').valor, '0905103495');
  assert.ok(p.scanImport.dudas.includes('cedula'), 'se marca para mirarlo con el PDF delante');
  assert.equal(await Patient.countDocuments({}), 2, 'y no se inventa un tercero');
});

// ───────── CRM: el chat pasa a ser el chat del paciente ─────────
//
// Para qué: el call center abría un chat llamado "Karol❤️" y, para agendar, tenía
// que registrar al paciente a mano aunque llevara meses en el sistema.

test('I25) el chat de ese número queda vinculado al paciente y toma su nombre', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);
  const chat = await Conversation.create({
    clinic: clinicId,
    phone: '593994967491',          // el mismo número, en formato internacional
    contactName: 'Pepe 🎉',          // el apodo del perfil de WhatsApp
    contactNameSource: 'profile',
  });

  await importar([fichaBuena()]);

  const p = await Patient.findOne({ cedula: '0905103495' });
  const c = await Conversation.findById(chat._id);
  assert.equal(String(c.patient), String(p._id), 'ya no hay que registrarlo para agendar');
  assert.equal(c.contactName, 'JOSÉ CUZCO ESPINOZA', 'el agente ve con quién habla');
  assert.equal(c.contactNameSource, 'contact');
});

test('I26) no pisa el nombre que escribió un agente ni roba el chat de otro paciente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { name: 'Hoja 1' });
  await seedEscaneo(clinicId, userId, { name: 'Hoja 2' });

  const aMano = await Conversation.create({
    clinic: clinicId, phone: '593994967491',
    contactName: 'Mamá de José', contactNameSource: 'manual', contactNameEditedAt: new Date(),
  });
  const otroPaciente = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Vera' });
  const ajeno = await Conversation.create({
    clinic: clinicId, phone: '593994967492', patient: otroPaciente._id, contactName: 'Ana',
  });

  await importar([
    fichaBuena('Hoja 1'),
    fichaBuena('Hoja 2', { cedula: '0912172251', nombres: 'Luis', apellidos: 'Mora', celular: '0994967492' }),
  ]);

  const a = await Conversation.findById(aMano._id);
  assert.equal(a.contactName, 'Mamá de José', 'lo escrito a mano no lo pisa una importación');
  assert.ok(a.patient, 'pero sí se vincula: el vínculo no molesta a nadie');

  const b = await Conversation.findById(ajeno._id);
  assert.equal(String(b.patient), String(otroPaciente._id), 'un chat ya vinculado no cambia de dueño');
  assert.equal(b.contactName, 'Ana');
});

// ───────── La importación anterior se convierte, no se duplica ─────────

test('I27) una ficha importada con el criterio viejo se reparte en ficha + hojas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const doc = await seedEscaneo(clinicId, userId, { paginas: 3 });

  // Estado que dejó la importación de agosto: el PDF ENTERO en el seguimiento y
  // ninguna observación.
  const p = await Patient.create({
    clinic: clinicId, cedula: '0905103495', firstName: 'José', lastName: 'Cuzco Espinoza',
    scanImport: { scan: doc._id, importadoAt: new Date() },
  });
  const dirViejo = path.join(dirs.followups, String(clinicId));
  await fsp.mkdir(dirViejo, { recursive: true });
  await fsp.writeFile(path.join(dirViejo, 'viejo.pdf'), Buffer.from('%PDF-1.4 entero'));
  await ClinicalRecord.create({
    clinic: clinicId, patient: p._id, fecha: new Date('2026-06-01'), nombre: 'José Cuzco Espinoza',
    followUps: [{
      fecha: new Date('2026-06-01'),
      tipoConsulta: 'primera',
      observaciones: NOTA_SEGUIMIENTO,
      attachments: [{
        filename: 'viejo.pdf',
        originalName: 'Ficha Jose Cuzco.pdf',   // el nombre del criterio viejo
        mimeType: 'application/pdf',
        size: 15,
      }],
    }],
  });

  await importar([fichaBuena()]);

  const rec = await ClinicalRecord.findOne({ patient: p._id });
  assert.equal(rec.followUps.length, 1, 'no se le cuelga el documento otra vez');
  assert.equal(rec.followUps[0].attachments.length, 1);
  assert.equal(
    rec.followUps[0].attachments[0].originalName,
    'Ficha Jose Cuzco - ficha.pdf',
    'el adjunto pasa a ser solo la ficha'
  );
  assert.notEqual(rec.followUps[0].attachments[0].filename, 'viejo.pdf', 'y apunta al archivo nuevo');

  const obs = await PatientObservation.findOne({ patient: p._id });
  assert.ok(obs, 'ahora sí tiene sus hojas de seguimiento en observaciones');
  assert.equal(obs.attachments[0].mimeType, 'application/pdf');

  // La copia entera que ya no referencia nadie se borra; el ORIGINAL sigue intacto.
  await assert.rejects(() => fsp.readFile(path.join(dirViejo, 'viejo.pdf')));
  assert.ok(await ScannedDocument.findById(doc._id), 'el escáner no se toca');
});
