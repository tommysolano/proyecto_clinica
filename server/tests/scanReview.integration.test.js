/**
 * REVISIÓN DE LAS FICHAS ESCANEADAS (controllers/scanReviewController.js).
 *
 * Los pacientes que entraron desde papel llegan con dudas marcadas y aquí se
 * corrigen. Lo que hay que demostrar es que la corrección llega a los DOS sitios:
 * al paciente y a su ficha clínica. Al importar, los mismos datos se copiaron a
 * la historia; si la revisión solo arreglara el paciente, el doctor seguiría
 * viendo la cédula equivocada y nadie se enteraría.
 *
 * Los casos parten de una importación de verdad, no de documentos fabricados a
 * mano: así se prueba la cadena entera tal como ocurre en producción.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const os = require('os');
const fsp = require('fs/promises');
const H = require('./_integrationHelpers');

const { importarFichas } = require('../scripts/importPatientsFromScans');
const { NOTA_SEGUIMIENTO } = require('../utils/scanPatientExtract');
const ctrl = require('../controllers/scanReviewController');

const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const ScannedDocument = require('../models/ScannedDocument');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });

let dirs;
let raiz;

test.beforeEach(async () => {
  await H.resetDb();
  raiz = await fsp.mkdtemp(path.join(os.tmpdir(), 'shiluv-review-test-'));
  dirs = { scans: path.join(raiz, 'scans'), followups: path.join(raiz, 'followups') };
});

test.afterEach(async () => {
  await fsp.rm(raiz, { recursive: true, force: true }).catch(() => {});
});

/**
 * Importa una ficha con dudas y devuelve el escenario listo para revisar.
 * Por defecto la cédula tiene un dígito mal y el celular es ilegible.
 */
async function escenario(ficha = {}) {
  const { clinicId, userId } = await H.seedClinic();
  const nombre = 'Ficha Jose Cuzco';
  const dir = path.join(dirs.scans, String(clinicId));
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'ficha.pdf'), Buffer.from('%PDF-1.4 prueba'));
  const doc = await ScannedDocument.create({
    clinic: clinicId, name: nombre, nameKey: nombre.toLowerCase(),
    filename: 'ficha.pdf', size: 15, pages: 1, createdBy: userId,
  });

  await importarFichas({
    commit: true,
    dirs,
    fichas: [{
      documento: nombre,
      fecha: '1-06-26',
      nombres: 'José',
      apellidos: 'Cuzco Espinoza',
      cedula: '0905103496',   // 10 dígitos, verificador incorrecto → duda
      edad: '71',
      celular: '12345',       // imposible → duda
      correo: 'josecuzco@gmail.com',
      direccion: 'Barrio Garay',
      dudosos: [],
      ...ficha,
    }],
  });

  const paciente = await Patient.findOne({ 'scanImport.scan': doc._id });
  return { clinicId, userId, doc, paciente };
}

const revisar = (clinicId, userId, id, body) =>
  H.runController(ctrl.saveScanReview, H.mockReq(clinicId, userId, body, { params: { id: String(id) } }));

// ───────────────────────── Listado ─────────────────────────

test('R1) por defecto lista solo las pendientes, con el nombre del documento y la fecha', async () => {
  const { clinicId, userId } = await escenario();

  const r = await H.runController(ctrl.listScanImports, H.mockReq(clinicId, userId, {}, { query: {} }));
  assert.equal(r.statusCode, 200);
  assert.equal(r.payload.length, 1);

  const fila = r.payload[0];
  assert.equal(fila.scanName, 'Ficha Jose Cuzco', 'sabe qué documento abrir');
  assert.ok(fila.scanImport.dudas.includes('cedula'));
  assert.equal(new Date(fila.fecha).getMonth(), 5, 'trae la fecha de la ficha (junio)');
});

test('R2) el contador dice cuántas quedan por revisar', async () => {
  const { clinicId, userId, paciente } = await escenario();

  let r = await H.runController(ctrl.countPendingScanImports, H.mockReq(clinicId, userId));
  assert.equal(r.payload.pendientes, 1);

  await revisar(clinicId, userId, paciente._id, { cedula: '0905103495' });

  r = await H.runController(ctrl.countPendingScanImports, H.mockReq(clinicId, userId));
  assert.equal(r.payload.pendientes, 0, 'al revisarla deja de contar');
});

// ───────────────────────── Corrección ─────────────────────────

test('R3) corregir un dato lo arregla también en la ficha clínica, no solo en el paciente', async () => {
  const { clinicId, userId, paciente } = await escenario();

  const r = await revisar(clinicId, userId, paciente._id, {
    cedula: '0905103495',
    phone: '0994967491',
    address: 'Barrio Garay, calle 5',
  });
  assert.equal(r.statusCode, 200);

  const p = await Patient.findById(paciente._id);
  assert.equal(p.cedula, '0905103495');
  assert.equal(p.phone, '0994967491');

  const rec = await ClinicalRecord.findOne({ patient: paciente._id });
  assert.equal(rec.cedula, '0905103495', 'la historia clínica también queda corregida');
  assert.equal(rec.celular, '0994967491');
  assert.equal(rec.direccion, 'Barrio Garay, calle 5');
  assert.equal(rec.nombre, `${p.firstName} ${p.lastName}`, 'el nombre de la ficha sigue el del paciente');
});

test('R4) corregir la fecha mueve la ficha y el seguimiento que trae el PDF', async () => {
  const { clinicId, userId, paciente } = await escenario();

  await revisar(clinicId, userId, paciente._id, { fecha: '2026-03-15' });

  const rec = await ClinicalRecord.findOne({ patient: paciente._id });
  assert.equal(rec.fecha.getMonth(), 2, 'marzo');
  assert.equal(rec.fecha.getDate(), 15);

  const fu = rec.followUps.find((s) => s.observaciones === NOTA_SEGUIMIENTO);
  assert.ok(fu, 'el seguimiento de la importación sigue identificable');
  assert.equal(fu.fecha.getMonth(), 2, 'el seguimiento se mueve con la ficha');
  assert.equal(fu.attachments.length, 1, 'y conserva el PDF adjunto');
});

test('R5) al guardar, la ficha queda revisada y sin dudas pendientes', async () => {
  const { clinicId, userId, paciente } = await escenario();
  assert.ok(paciente.scanImport.dudas.length > 0, 'nace con dudas');

  await revisar(clinicId, userId, paciente._id, { cedula: '0905103495' });

  const p = await Patient.findById(paciente._id);
  assert.deepEqual(p.scanImport.dudas, []);
  assert.ok(p.scanImport.revisadoAt, 'queda sellada');
  assert.equal(String(p.scanImport.revisadoBy), String(userId), 'consta quién la revisó');

  const r = await H.runController(ctrl.listScanImports, H.mockReq(clinicId, userId, {}, { query: {} }));
  assert.equal(r.payload.length, 0, 'sale de la lista de pendientes');
});

test('R6) guardar sin cambios vale como "lo revisé y estaba bien"', async () => {
  const { clinicId, userId, paciente } = await escenario();

  const r = await revisar(clinicId, userId, paciente._id, {});
  assert.equal(r.statusCode, 200);

  const p = await Patient.findById(paciente._id);
  assert.ok(p.scanImport.revisadoAt);
  assert.equal(p.cedula, '0905103496', 'el dato dudoso se confirma tal cual estaba');
});

// ───────────────────────── Errores ─────────────────────────

test('R7) una cédula que choca con otro paciente avisa en vez de reventar', async () => {
  const { clinicId, userId, paciente } = await escenario();
  await Patient.create({ clinic: clinicId, cedula: '0917339210', firstName: 'Otra', lastName: 'Persona' });

  const r = await revisar(clinicId, userId, paciente._id, { cedula: '0917339210' });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /Ya existe otro paciente con esa cédula/);
  const p = await Patient.findById(paciente._id);
  assert.equal(p.cedula, '0905103496', 'no se guardó a medias');
  assert.equal(p.scanImport.revisadoAt, null, 'sigue pendiente de revisar');
});

test('R8) no se puede dejar al paciente sin nombre', async () => {
  const { clinicId, userId, paciente } = await escenario();

  const r = await revisar(clinicId, userId, paciente._id, { firstName: '', lastName: '' });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no pueden quedar vac/i);
});

test('R9) un paciente que no vino de una ficha escaneada no entra por aquí', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const normal = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Solís' });

  const r = await revisar(clinicId, userId, normal._id, { cedula: '0905103495' });

  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no vino de una ficha escaneada/);
});

test('R10) no se revisan fichas de otra sucursal', async () => {
  const { paciente } = await escenario();
  const otra = await H.seedClinic();

  const r = await revisar(otra.clinicId, otra.userId, paciente._id, { cedula: '0905103495' });

  assert.equal(r.statusCode, 404);
});

test('R11) al revisar se resuelven los dos valores: se queda uno y el otro se retira', async () => {
  // El paciente venía de Contífico con un teléfono y la ficha física decía otro.
  // La revisión es justamente el acto de decidir; dejar el alterno después haría
  // que la ficha del paciente siguiera enseñando los dos para siempre.
  const { clinicId, userId, paciente } = await escenario();
  paciente.phone = '0991112233';
  paciente.scanImport.alternos = [{ campo: 'celular', valor: '0999999999' }];
  await paciente.save();

  await revisar(clinicId, userId, paciente._id, { phone: '0999999999' });

  const p = await Patient.findById(paciente._id);
  assert.equal(p.phone, '0999999999', 'gana el que eligió quien revisó');
  assert.deepEqual(p.scanImport.alternos, [], 'y el otro deja de aparecer');
});
