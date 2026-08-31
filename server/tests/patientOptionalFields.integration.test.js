/**
 * REGISTRAR UN PACIENTE CON LO QUE SE TENGA.
 *
 * Nombre, apellido y género dejaron de ser obligatorios. Al paciente se le da de
 * alta muchas veces con un dato suelto —el teléfono de quien llamó, la cédula
 * que trae en la mano— y se completa después; exigir los tres empujaba a
 * inventárselos, que es peor dato que ninguno.
 *
 * Se prueba en el SERVIDOR, no solo en el formulario: quitar el `required` del
 * HTML y dejarlo en el esquema convierte un campo vacío en un error de guardado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const patients = require('../controllers/patientController');
const Patient = require('../models/Patient');

const ok = (r) => {
  assert.equal(r.statusCode < 400, true, `esperaba éxito: ${JSON.stringify(r.payload)}`);
  return r.payload;
};

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('se registra un paciente solo con el teléfono', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const creado = ok(await H.runController(
    patients.createPatient,
    H.mockReq(clinicId, userId, { phone: '0991112233' }, { role: 'cajero' })
  ));

  const enBase = await Patient.findById(creado._id);
  assert.equal(enBase.phone, '0991112233');
  assert.equal(enBase.firstName, '', 'sin nombre no es un error, es un paciente a medio registrar');
  assert.equal(enBase.lastName, '');
  assert.equal(enBase.gender, undefined, 'el enum no admite la cadena vacía: va sin valor');
});

test('se registra un paciente solo con la cédula', async () => {
  const { clinicId, userId } = await H.seedClinic();

  ok(await H.runController(
    patients.createPatient,
    H.mockReq(clinicId, userId, { cedula: '0102030405', gender: '' }, { role: 'cajero' })
  ));

  const enBase = await Patient.findOne({ cedula: '0102030405' });
  assert.ok(enBase, 'se guardó');
  assert.equal(enBase.gender, undefined, 'el género vacío no revienta el guardado');
});

test('el nombre completo de un paciente sin nombre no es un espacio en blanco', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const creado = ok(await H.runController(
    patients.createPatient,
    H.mockReq(clinicId, userId, { phone: '0999999999' }, { role: 'cajero' })
  ));

  const enBase = await Patient.findById(creado._id);
  assert.equal(enBase.fullName, '', 'la pantalla decide qué poner; el modelo no inventa " "');

  // Y con solo el nombre, tampoco arrastra el espacio del apellido que falta.
  const soloNombre = await Patient.create({ clinic: clinicId, firstName: 'ANA' });
  assert.equal(soloNombre.fullName, 'ANA');
});

test('lo que sí se rellena se sigue guardando y normalizando', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const creado = ok(await H.runController(
    patients.createPatient,
    H.mockReq(
      clinicId, userId,
      { firstName: 'ana maria', lastName: 'perez', gender: 'femenino' },
      { role: 'cajero' }
    )
  ));

  const enBase = await Patient.findById(creado._id);
  assert.equal(enBase.firstName, 'ANA MARIA', 'el uppercase del esquema sigue vivo');
  assert.equal(enBase.lastName, 'PEREZ');
  assert.equal(enBase.gender, 'femenino');
});
