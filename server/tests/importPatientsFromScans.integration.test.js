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
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });

let dirs;
let raiz;

test.beforeEach(async () => {
  await H.resetDb();
  raiz = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiluv-scans-test-'));
  dirs = { scans: path.join(raiz, 'scans'), followups: path.join(raiz, 'followups') };
});

test.afterEach(async () => {
  await fsp.rm(raiz, { recursive: true, force: true }).catch(() => {});
});

/** Contenido reconocible: sirve para probar que la copia es fiel al original. */
const CONTENIDO_PDF = Buffer.from('%PDF-1.4 ficha fisica de prueba');

/** Crea el ScannedDocument y deja su PDF en disco, como lo dejaría el escáner. */
async function seedEscaneo(clinicId, userId, { name = 'Ficha Jose Cuzco', createdAt = new Date('2026-06-10T15:00:00') } = {}) {
  const filename = `${name.replace(/\s+/g, '_')}.pdf`;
  const dir = path.join(dirs.scans, String(clinicId));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, filename), CONTENIDO_PDF);

  const doc = await ScannedDocument.create({
    clinic: clinicId,
    name,
    nameKey: name.toLowerCase(),
    filename,
    size: CONTENIDO_PDF.length,
    pages: 1,
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

const importar = (fichas, opts = {}) => importarFichas({ fichas, commit: true, dirs, ...opts });

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
  assert.equal(fu.attachments[0].originalName, 'Ficha Jose Cuzco.pdf');
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

test('I6) correr el importador dos veces no duplica al paciente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);

  await importar([fichaBuena()]);
  const segunda = await importar([fichaBuena()]);

  assert.equal(segunda.creados.length, 0);
  assert.equal(segunda.omitidos.length, 1);
  assert.match(segunda.omitidos[0].motivo, /ya se importó/);
  assert.equal(await Patient.countDocuments({}), 1);
  assert.equal(await ClinicalRecord.countDocuments({}), 1);
});

test('I7) una cédula que ya existe se omite en vez de reventar por clave duplicada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId);
  await Patient.create({ clinic: clinicId, cedula: '0905103495', firstName: 'Jose', lastName: 'Cuzco' });

  const r = await importar([fichaBuena()]);

  assert.equal(r.errores.length, 0, 'un duplicado esperado no es un error técnico');
  assert.equal(r.omitidos.length, 1);
  assert.match(r.omitidos[0].motivo, /ya hay un paciente con la cédula/);
  assert.equal(await Patient.countDocuments({}), 1, 'no se creó un segundo registro');
});

test('I8) la misma cédula repetida dentro del lote solo entra una vez', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedEscaneo(clinicId, userId, { name: 'Ficha A' });
  await seedEscaneo(clinicId, userId, { name: 'Ficha B' });

  const r = await importar([fichaBuena('Ficha A'), fichaBuena('Ficha B')]);

  assert.equal(r.creados.length, 1);
  assert.equal(r.omitidos.length, 1);
  assert.match(r.omitidos[0].motivo, /repetida dentro del mismo lote/);
  assert.equal(await Patient.countDocuments({}), 1);
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
