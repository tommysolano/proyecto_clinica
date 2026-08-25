/**
 * OBSERVACIONES del paciente (pestaña «Observaciones» de la ficha de Clientes).
 *
 * Lo que no puede romperse sin que nadie lo note:
 *  · el orden — la última que se escribió va primero;
 *  · quién puede corregir — su autor, y el admin;
 *  · que el paso del admin QUEDE REGISTRADO. Sin `updatedBy`, un administrador
 *    podría reescribir la nota de otra persona y la ficha seguiría diciendo que
 *    la escribió ella y nadie la tocó.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./_integrationHelpers');

const Patient = require('../models/Patient');
const User = require('../models/User');
const PatientObservation = require('../models/PatientObservation');
const observations = require('../controllers/patientObservationController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function seedUsuario(clinicId, name, role) {
  return User.create({
    name,
    email: `${name.toLowerCase().replace(/\s/g, '')}@test.com`,
    password: 'secreto123',
    clinics: [{ clinic: clinicId, role }],
  });
}

async function seedPaciente(clinicId) {
  return Patient.create({ clinic: clinicId, firstName: 'ANA', lastName: 'PEREZ', cedula: '0102030405' });
}

/** Petición con `files` (lo que deja multer tras la subida). */
const req = (clinicId, userId, body, extra = {}) => {
  const r = H.mockReq(clinicId, userId, body, extra);
  r.files = extra.files || [];
  return r;
};

const crear = (clinicId, userId, role, patientId, body, files) =>
  H.runController(observations.create, req(clinicId, userId, body, { role, params: { id: String(patientId) }, files }));

const listar = (clinicId, userId, role, patientId) =>
  H.runController(observations.list, req(clinicId, userId, {}, { role, params: { id: String(patientId) } }));

const editar = (clinicId, userId, role, patientId, obsId, text) =>
  H.runController(
    observations.update,
    req(clinicId, userId, { text }, { role, params: { id: String(patientId), obsId: String(obsId) } })
  );

test('O1) se listan de la más nueva a la más vieja, con su autor', async () => {
  const { clinicId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);
  const recepcion = await seedUsuario(clinicId, 'Recepcion Uno', 'cajero');

  ok(await crear(clinicId, recepcion._id, 'cajero', patient._id, { text: 'La primera' }));
  ok(await crear(clinicId, recepcion._id, 'cajero', patient._id, { text: 'La segunda' }));
  ok(await crear(clinicId, recepcion._id, 'cajero', patient._id, { text: 'La tercera' }));

  const rows = ok(await listar(clinicId, recepcion._id, 'cajero', patient._id));
  assert.deepEqual(rows.map((r) => r.text), ['La tercera', 'La segunda', 'La primera']);
  assert.equal(rows[0].createdBy.name, 'Recepcion Uno');
  assert.equal(rows[0].updatedBy, null, 'recién creada, nadie la ha modificado');
});

test('O2) una observación vacía (sin texto ni archivos) se rechaza', async () => {
  const { clinicId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);
  const user = await seedUsuario(clinicId, 'Enfermera', 'enfermero');

  const r = await crear(clinicId, user._id, 'enfermero', patient._id, { text: '   ' });
  assert.equal(r.statusCode, 400);
});

test('O3) solo la modifica quien la escribió', async () => {
  const { clinicId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);
  const autora = await seedUsuario(clinicId, 'Autora', 'cajero');
  const otro = await seedUsuario(clinicId, 'Otro Cajero', 'cajero');

  const obs = ok(await crear(clinicId, autora._id, 'cajero', patient._id, { text: 'Vino con la mamá' }));

  const ajeno = await editar(clinicId, otro._id, 'cajero', patient._id, obs._id, 'La cambio yo');
  assert.equal(ajeno.statusCode, 403);
  assert.equal((await PatientObservation.findById(obs._id)).text, 'Vino con la mamá');

  const propia = ok(await editar(clinicId, autora._id, 'cajero', patient._id, obs._id, 'Vino con su madre'));
  assert.equal(propia.text, 'Vino con su madre');
  assert.equal(String(propia.updatedBy._id), String(autora._id));
});

test('O4) el admin también la modifica, pero queda registrado quién fue', async () => {
  const { clinicId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);
  const autora = await seedUsuario(clinicId, 'Autora', 'cajero');
  const admin = await seedUsuario(clinicId, 'Jefa', 'admin');

  const obs = ok(await crear(clinicId, autora._id, 'cajero', patient._id, { text: 'Texto original' }));
  const editada = ok(await editar(clinicId, admin._id, 'admin', patient._id, obs._id, 'Texto corregido'));

  assert.equal(editada.text, 'Texto corregido');
  assert.equal(editada.createdBy.name, 'Autora', 'sigue constando quién la escribió');
  assert.equal(editada.updatedBy.name, 'Jefa', 'y ahora también quién la tocó');
  assert.ok(editada.editedAt, 'con la fecha del cambio');
});

test('O5) borrar la observación se lleva sus archivos del disco', async () => {
  const { clinicId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);
  const autora = await seedUsuario(clinicId, 'Autora', 'cajero');

  // Simula lo que deja multer: el archivo ya escrito en storage/observations/<paciente>.
  const dir = path.join(__dirname, '..', 'storage', 'observations', String(patient._id));
  fs.mkdirSync(dir, { recursive: true });
  const filename = `test-${Date.now()}.txt`;
  fs.writeFileSync(path.join(dir, filename), 'resultado de laboratorio');

  const obs = ok(await crear(
    clinicId, autora._id, 'cajero', patient._id, { text: 'Adjunto el examen' },
    [{ filename, originalname: 'examen.txt', mimetype: 'text/plain', size: 24, path: path.join(dir, filename) }]
  ));
  assert.equal(obs.attachments.length, 1);
  assert.equal(obs.attachments[0].originalName, 'examen.txt');

  ok(await H.runController(
    observations.remove,
    req(clinicId, autora._id, {}, { role: 'cajero', params: { id: String(patient._id), obsId: String(obs._id) } })
  ));
  assert.equal(await PatientObservation.countDocuments({}), 0);
  assert.equal(fs.existsSync(path.join(dir, filename)), false, 'el archivo no puede quedar huérfano');
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* limpieza best-effort */ }
});

test('O6) un id mal formado responde 400, no un 500 mudo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  let status = 0;
  observations.validateIds(
    { params: { id: 'no-es-un-id' } },
    { status(code) { status = code; return this; }, json() { return this; } },
    () => { status = 200; }
  );
  assert.equal(status, 400);
  assert.ok(clinicId && userId);
});
