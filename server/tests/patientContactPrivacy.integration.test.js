/**
 * DATOS DE CONTACTO DEL PACIENTE: cédula, dirección, teléfono, WhatsApp y correo.
 *
 * La regla es que los ve SOLO el administrador. Lo que se vigila aquí es que se
 * cumpla en el SERVIDOR y no solo en React: ocultar una columna no es un permiso,
 * cualquiera abre la pestaña de red y lee el JSON.
 *
 * Y las dos trampas del cambio:
 *  1. La factura electrónica necesita identificar al cliente. Si el selector de
 *     Nueva venta dejara de recibir la cédula, todo saldría a consumidor final.
 *  2. Quien no ve esos campos recibe el formulario vacío: sin filtrar el PUT, un
 *     guardado cualquiera borraría la cédula y el teléfono del paciente.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const patients = require('../controllers/patientController');
const clinicalRecords = require('../controllers/clinicalRecordController');

const CONTACT_FIELDS = ['cedula', 'address', 'phone', 'whatsapp', 'email'];

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function seedPaciente(clinicId) {
  return Patient.create({
    clinic: clinicId,
    firstName: 'ANA',
    lastName: 'PEREZ',
    cedula: '0102030405',
    phone: '0991112233',
    whatsapp: '0991112233',
    email: 'ana@example.com',
    address: 'Av. Siempre Viva 123',
    gender: 'femenino',
  });
}

const getOne = (clinicId, userId, role, id) =>
  H.runController(patients.getPatient, H.mockReq(clinicId, userId, {}, { role, params: { id: String(id) } }));

const list = (clinicId, userId, role, query = {}) =>
  H.runController(patients.getPatients, H.mockReq(clinicId, userId, {}, { role, query }));

test('P1) la ficha del paciente llega con los datos de contacto solo para el admin', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);

  const comoAdmin = ok(await getOne(clinicId, userId, 'admin', patient._id));
  for (const f of CONTACT_FIELDS) {
    assert.ok(comoAdmin[f], `el admin debe ver ${f}`);
  }

  for (const rol of ['cajero', 'doctor', 'call_center', 'enfermero', 'marketing', 'odontologia']) {
    const visto = ok(await getOne(clinicId, userId, rol, patient._id));
    assert.equal(visto.firstName, 'ANA', `${rol} sigue viendo el nombre`);
    for (const f of CONTACT_FIELDS) {
      assert.equal(visto[f], undefined, `${rol} NO debe recibir ${f}`);
    }
  }
});

test('P2) el super-admin ve el contacto aunque su rol en la sede no sea admin', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);
  const req = H.mockReq(clinicId, userId, {}, { role: 'cajero', params: { id: String(patient._id) } });
  req.user.isSuperAdmin = true;

  const visto = ok(await H.runController(patients.getPatient, req));
  assert.equal(visto.cedula, '0102030405');
});

test('P3) el listado censura igual, y solo el selector de facturación pide el contacto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedPaciente(clinicId);

  const paraCajero = ok(await list(clinicId, userId, 'cajero'));
  assert.equal(paraCajero.patients[0].cedula, undefined, 'el listado de Clientes va censurado');

  // Nueva venta / Cotizaciones / Pagos: `withContact=1` + capacidad de facturar.
  const paraFacturar = ok(await list(clinicId, userId, 'cajero', { withContact: '1' }));
  assert.equal(paraFacturar.patients[0].cedula, '0102030405', 'sin cédula la factura sale a consumidor final');
  assert.equal(paraFacturar.patients[0].email, 'ana@example.com');

  const contable = ok(await list(clinicId, userId, 'contabilidad', { withContact: '1' }));
  assert.equal(contable.patients[0].cedula, '0102030405', 'la cartera identifica al tercero por su cédula');

  // Quien no factura no consigue nada pidiéndolo.
  for (const rol of ['doctor', 'call_center', 'enfermero', 'marketing']) {
    const r = ok(await list(clinicId, userId, rol, { withContact: '1' }));
    assert.equal(r.patients[0].cedula, undefined, `${rol} no puede saltarse la regla con withContact`);
  }
});

/**
 * BUSCAR por cédula o teléfono lo puede hacer cualquiera que ya entre al
 * listado; VERLOS sigue siendo solo del admin.
 *
 * Antes tampoco se podía buscar, con el argumento de que probar números hasta
 * acertar es otra forma de leerlos. En la práctica el coste lo pagaba el trabajo
 * diario —recepción tiene la cédula del paciente delante y solo podía buscar por
 * un nombre que se escribe de tres maneras— sin cerrar nada: para buscar hay que
 * traer el número ya sabido. La censura de la respuesta, que es lo que de verdad
 * protege el dato, no se ha tocado y se comprueba aquí abajo.
 */
test('P4) buscar por cédula o teléfono lo hace cualquiera; VERLOS sigue siendo del admin', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedPaciente(clinicId);

  const admin = ok(await list(clinicId, userId, 'admin', { search: '0102030405' }));
  assert.equal(admin.total, 1);

  const cajero = ok(await list(clinicId, userId, 'cajero', { search: '0102030405' }));
  assert.equal(cajero.total, 1, 'recepción tiene la cédula delante: tiene que poder buscarla');
  assert.equal(cajero.patients[0].cedula, undefined, 'encontrarlo NO le enseña la cédula');
  assert.equal(cajero.patients[0].phone, undefined, 'ni el teléfono');

  // El teléfono casa escrito en cualquier formato (phoneSearchRegex).
  const porTelefono = ok(await list(clinicId, userId, 'cajero', { search: '099 111 22 33' }));
  assert.equal(porTelefono.total, 1, 'el teléfono se busca con espacios o sin ellos');

  // El nombre sigue buscándose para todos: es como se encuentra al paciente.
  const porNombre = ok(await list(clinicId, userId, 'cajero', { search: 'ANA' }));
  assert.equal(porNombre.total, 1);

  // Un texto con metacaracteres no puede reventar la consulta (antes iba crudo
  // al $regex y un '(' de un teléfono copiado devolvía un 500).
  const raro = ok(await list(clinicId, userId, 'cajero', { search: '(0991' }));
  assert.equal(typeof raro.total, 'number', 'el buscador escapa lo que se teclee');
});

test('P5) guardar desde un rol sin acceso NO borra la cédula ni el teléfono', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);

  // Justo lo que manda el formulario del cajero: los campos que no ve, vacíos.
  const body = { firstName: 'ANA MARIA', cedula: '', phone: '', email: '', address: '', whatsapp: '' };
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, body, { role: 'cajero', params: { id: String(patient._id) } })
  ));

  const enBase = await Patient.findById(patient._id);
  assert.equal(enBase.firstName, 'ANA MARIA', 'lo que sí puede editar se guarda');
  assert.equal(enBase.cedula, '0102030405', 'la cédula sigue ahí');
  assert.equal(enBase.phone, '0991112233', 'el teléfono sigue ahí');
  assert.equal(enBase.email, 'ana@example.com');
  assert.equal(enBase.address, 'Av. Siempre Viva 123');

  // Y el admin sí los cambia.
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, { phone: '0987654321' }, { role: 'admin', params: { id: String(patient._id) } })
  ));
  assert.equal((await Patient.findById(patient._id)).phone, '0987654321');
});

test('P6) la cabecera de la hoja MSP guarda su propia copia: también va censurada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);
  await ClinicalRecord.create({
    clinic: clinicId,
    patient: patient._id,
    cedula: '0102030405',
    direccion: 'Av. Siempre Viva 123',
    celular: '0991112233',
    createdBy: userId,
  });

  const params = { patientId: String(patient._id) };
  const comoDoctor = ok(await H.runController(
    clinicalRecords.getOrCreateByPatient, H.mockReq(clinicId, userId, {}, { role: 'doctor', params })
  ));
  assert.equal(comoDoctor.cedula, undefined);
  assert.equal(comoDoctor.direccion, undefined);
  assert.equal(comoDoctor.celular, undefined);

  // Y guardar desde ese rol no los borra de la ficha.
  ok(await H.runController(
    clinicalRecords.updateByPatient,
    H.mockReq(clinicId, userId, { cedula: '', direccion: '', celular: '', nombre: 'ANA PEREZ' }, { role: 'doctor', params })
  ));
  const ficha = await ClinicalRecord.findOne({ clinic: clinicId, patient: patient._id });
  assert.equal(ficha.cedula, '0102030405');
  assert.equal(ficha.celular, '0991112233');
  assert.equal(ficha.nombre, 'ANA PEREZ');
});

test('P7) el buscador de referidores no devuelve cédulas a quien no puede verlas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await seedPaciente(clinicId);

  const admin = ok(await H.runController(
    patients.searchReferralCandidates, H.mockReq(clinicId, userId, {}, { role: 'admin', query: { q: 'ANA' } })
  ));
  assert.equal(admin.find((r) => r.type === 'patient').detail, '0102030405');

  const cajero = ok(await H.runController(
    patients.searchReferralCandidates, H.mockReq(clinicId, userId, {}, { role: 'cajero', query: { q: 'ANA' } })
  ));
  const fila = cajero.find((r) => r.type === 'patient');
  assert.ok(fila, 'sigue encontrando al paciente por su nombre');
  assert.equal(fila.detail, '', 'pero sin la cédula al lado');
});
