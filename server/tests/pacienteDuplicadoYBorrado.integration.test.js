/**
 * ALTA CON AVISO DE DUPLICADO + BORRADO DE VERDAD (nov-2026).
 *
 * - «ABEL DARÍO PONCE MARTÍNEZ» y «ABEL DARIO PONCE MARTINEZ» acabaron siendo
 *   dos fichas: POST /patients no miraba nombre (sin tildes) ni teléfono.
 * - Eliminar un paciente solo lo desactivaba y su cédula seguía ocupada:
 *   «ya existe» sin que el buscador lo encontrara.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const patients = require('../controllers/patientController');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');

const crear = (clinicId, userId, body) =>
  H.runController(patients.createPatient, H.mockReq(clinicId, userId, body, { role: 'admin' }));
const borrar = (clinicId, userId, id) =>
  H.runController(patients.deletePatient, H.mockReq(clinicId, userId, {}, { role: 'admin', params: { id: String(id) } }));

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

test('D1) mismo nombre con/sin tildes → 409 POSSIBLE_DUPLICATE; confirmDuplicate lo crea', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Patient.create({ clinic: clinicId, firstName: 'ABEL DARÍO', lastName: 'PONCE MARTÍNEZ', phone: '593961211936' });

  const r = await crear(clinicId, userId, { firstName: 'Abel Dario', lastName: 'Ponce Martinez', cedula: '0802217455' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.payload.code, 'POSSIBLE_DUPLICATE');
  assert.equal(r.payload.matches.length, 1);

  const r2 = await crear(clinicId, userId, { firstName: 'Abel Dario', lastName: 'Ponce Martinez', cedula: '0802217455', confirmDuplicate: true });
  assert.equal(r2.statusCode, 201);
});

test('D2) mismo celular en otro formato y nombre parecido → aviso; familiar con otro nombre → no', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Patient.create({ clinic: clinicId, firstName: 'ABEL', lastName: 'PONCE', phone: '593961211936' });

  const r = await crear(clinicId, userId, { firstName: 'Abel Darío', lastName: 'Ponce', phone: '0961211936' });
  assert.equal(r.statusCode, 409);
  assert.equal(r.payload.matches[0].motivo, 'teléfono');

  const madre = await crear(clinicId, userId, { firstName: 'María', lastName: 'Gómez', phone: '0961211936' });
  assert.equal(madre.statusCode, 201, 'un teléfono compartido con otro nombre no es la misma persona');
});

test('D3) mismo nombre con cédulas distintas → homónimos, sin aviso', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await Patient.create({ clinic: clinicId, firstName: 'JUAN', lastName: 'PEREZ', cedula: '0911111111' });
  const r = await crear(clinicId, userId, { firstName: 'Juan', lastName: 'Pérez', cedula: '0922222222' });
  assert.equal(r.statusCode, 201);
});

test('B1) eliminar sin nada vinculado lo borra de verdad y libera la cédula', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await Patient.create({ clinic: clinicId, firstName: 'X', lastName: 'Y', cedula: '0926045311' });
  const r = await borrar(clinicId, userId, p._id);
  assert.equal(r.statusCode < 400, true);
  assert.equal(r.payload.hardDeleted, true);
  assert.equal(await Patient.countDocuments({ _id: p._id }), 0);

  const otra = await crear(clinicId, userId, { firstName: 'Otra', lastName: 'Persona', cedula: '0926045311' });
  assert.equal(otra.statusCode, 201);
});

test('B2) eliminar con citas lo archiva y libera la cédula', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await Patient.create({ clinic: clinicId, firstName: 'X', lastName: 'Y', cedula: '0926045311' });
  await Appointment.collection.insertOne({ clinic: clinicId, patient: p._id, date: new Date(), status: 'pendiente' });

  const r = await borrar(clinicId, userId, p._id);
  assert.equal(r.payload.hardDeleted, false);
  const archivado = await Patient.findById(p._id).lean();
  assert.equal(archivado.active, false);
  assert.equal(archivado.cedula, '');
  assert.deepEqual(archivado.deletedIdentification, ['0926045311']);

  const otra = await crear(clinicId, userId, { firstName: 'Otra', lastName: 'Persona', cedula: '0926045311' });
  assert.equal(otra.statusCode, 201);
});
