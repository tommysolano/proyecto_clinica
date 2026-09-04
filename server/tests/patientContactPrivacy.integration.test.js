/**
 * DATOS DE CONTACTO DEL PACIENTE: cédula, dirección, teléfono, WhatsApp y correo.
 *
 * La regla es que los ve SOLO el administrador, con excepciones POR CAMPO:
 *  · MOSTRADOR ve cédula, dirección y correo (`patients.cedula`,
 *    `patients.address`, `patients.email`): son los TRES DATOS QUE LLEVA LA
 *    FACTURA ELECTRÓNICA, y ya los recibía al facturar con `?withContact=1`.
 *  · QUIEN ATIENDE ve el correo (`patients.email`), porque por ahí manda el
 *    resultado de un examen o la receta.
 *
 * TELÉFONO Y WHATSAPP no tienen excepción y son la línea que separa las dos
 * cosas: un dato del comprobante no es la vía de contacto directa con el
 * paciente. Lo que se vigila aquí es que se cumpla en el SERVIDOR y no solo en
 * React: ocultar una columna no es un permiso, cualquiera abre la pestaña de red
 * y lee el JSON.
 *
 * La EDAD no está en esta lista y nunca lo estuvo: no es un dato de contacto y
 * le llega a todo el mundo. Si sale vacía es porque el paciente no tiene fecha
 * de nacimiento, no porque esté censurada.
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
// Los dos que NO tienen excepción para nadie: siguen siendo solo del admin.
const SOLO_ADMIN = ['phone', 'whatsapp'];

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
    // Con fecha de nacimiento: la EDAD no es un dato de contacto y tiene que
    // llegarle a todo el mundo (ver P1). Sin fecha ni `age` sale vacía para
    // todos, admin incluido, que es otra cosa distinta de estar censurada.
    birthDate: new Date('1990-05-10'),
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

  for (const rol of ['call_center', 'enfermero', 'marketing']) {
    const visto = ok(await getOne(clinicId, userId, rol, patient._id));
    assert.equal(visto.firstName, 'ANA', `${rol} sigue viendo el nombre`);
    for (const f of CONTACT_FIELDS) {
      assert.equal(visto[f], undefined, `${rol} NO debe recibir ${f}`);
    }
  }

  /**
   * QUIEN ATIENDE VE EL CORREO, y solo el correo (sep-2026).
   *
   * Por ahí manda el resultado de un examen, la receta o las indicaciones.
   * Se comprueban también las ESPECIALIDADES: la capacidad se concede a la clave
   * 'doctor' y `can()` mapea todas ahí; si alguien rompiera esa expansión, el
   * dato desaparecería para todas menos medicina general sin que nadie lo note.
   */
  for (const rol of ['doctor', 'odontologia', 'optica', 'ginecologia', 'terapeuta']) {
    const visto = ok(await getOne(clinicId, userId, rol, patient._id));
    assert.equal(visto.email, 'ana@example.com', `${rol} necesita el correo del paciente`);
    assert.equal(visto.cedula, undefined, `${rol} sigue sin ver la cédula`);
    for (const f of ['address', 'phone', 'whatsapp']) {
      assert.equal(visto[f], undefined, `${rol} NO debe recibir ${f}`);
    }
  }

  // Y la EDAD, que no es un dato de contacto, le llega a todo el mundo: de ella
  // salen las dosis y por eso nunca se censuró.
  const comoDoctor = ok(await getOne(clinicId, userId, 'doctor', patient._id));
  assert.equal(typeof (comoDoctor.computedAge ?? comoDoctor.age), 'number', 'la edad llega calculada');

  /**
   * MOSTRADOR VE LOS TRES CAMPOS DE LA FACTURA (sep-2026).
   *
   * Cédula, dirección y correo son lo que va en el comprobante electrónico y lo
   * que caja ya recibía por la otra puerta (`?withContact=1` en los selectores
   * de Nueva venta). Teléfono y WhatsApp NO: esa es la línea.
   */
  const comoCajero = ok(await getOne(clinicId, userId, 'cajero', patient._id));
  assert.equal(comoCajero.cedula, '0102030405', 'mostrador identifica al paciente por su cédula');
  assert.equal(comoCajero.address, 'Av. Siempre Viva 123', 'la dirección va en la factura');
  assert.equal(comoCajero.email, 'ana@example.com', 'y a ese correo se manda el RIDE');
  for (const f of SOLO_ADMIN) {
    assert.equal(comoCajero[f], undefined, `el cajero NO debe recibir ${f}`);
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
  assert.equal(paraCajero.patients[0].cedula, '0102030405', 'mostrador ve la cédula');
  assert.equal(paraCajero.patients[0].address, 'Av. Siempre Viva 123');
  assert.equal(paraCajero.patients[0].email, 'ana@example.com');
  for (const f of SOLO_ADMIN) {
    assert.equal(paraCajero.patients[0][f], undefined, `el listado sigue censurando ${f}`);
  }

  const paraDoctor = ok(await list(clinicId, userId, 'doctor'));
  assert.equal(paraDoctor.patients[0].cedula, undefined, 'para quien atiende sigue censurada');
  assert.equal(paraDoctor.patients[0].phone, undefined, 'y el teléfono también');
  // El correo sí, también en el listado: es donde se busca al paciente.
  assert.equal(paraDoctor.patients[0].email, 'ana@example.com');

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
  assert.equal(cajero.patients[0].phone, undefined, 'encontrarlo NO le enseña el teléfono');

  const doctor = ok(await list(clinicId, userId, 'doctor', { search: '0102030405' }));
  assert.equal(doctor.total, 1, 'buscar por cédula lo hace cualquiera que entre al listado');
  assert.equal(doctor.patients[0].cedula, undefined, 'encontrarlo NO le enseña la cédula');

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

  // Justo lo que manda el formulario del cajero: teléfono y WhatsApp vacíos,
  // porque son los únicos dos que no ve. Cédula, dirección y correo SÍ los trae
  // rellenos (los ve), así que se mandan tal cual.
  const body = {
    firstName: 'ANA MARIA',
    cedula: '0102030405',
    email: 'ana@example.com',
    address: 'Av. Siempre Viva 123',
    phone: '',
    whatsapp: '',
  };
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, body, { role: 'cajero', params: { id: String(patient._id) } })
  ));

  const enBase = await Patient.findById(patient._id);
  assert.equal(enBase.firstName, 'ANA MARIA', 'lo que sí puede editar se guarda');
  assert.equal(enBase.cedula, '0102030405', 'la cédula sigue ahí');
  assert.equal(enBase.phone, '0991112233', 'el teléfono sigue ahí');
  assert.equal(enBase.whatsapp, '0991112233', 'y el WhatsApp también');
  assert.equal(enBase.email, 'ana@example.com');
  assert.equal(enBase.address, 'Av. Siempre Viva 123');

  // Y la corrige: es quien descubre al facturar que la dirección o el correo del
  // comprobante están mal.
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, {
      address: 'Av. Amazonas N34-12', email: 'ana.nueva@example.com',
    }, { role: 'cajero', params: { id: String(patient._id) } })
  ));
  const corregido = await Patient.findById(patient._id);
  assert.equal(corregido.address, 'Av. Amazonas N34-12', 'mostrador corrige la dirección');
  assert.equal(corregido.email, 'ana.nueva@example.com', 'y el correo');
  assert.equal(corregido.phone, '0991112233', 'sin tocar el teléfono');

  // Y quien NO ve la cédula tampoco la borra al guardar (el doctor la recibe
  // vacía, así que su formulario la manda vacía).
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, { cedula: '', firstName: 'ANA' }, { role: 'doctor', params: { id: String(patient._id) } })
  ));
  assert.equal((await Patient.findById(patient._id)).cedula, '0102030405', 'el doctor no la puede borrar');

  // Mostrador SÍ la corrige: es quien descubre que está mal, al facturar.
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, { cedula: '0999888777' }, { role: 'cajero', params: { id: String(patient._id) } })
  ));
  assert.equal((await Patient.findById(patient._id)).cedula, '0999888777', 'el cajero corrige la cédula');
  assert.equal((await Patient.findById(patient._id)).phone, '0991112233', 'y no toca el teléfono');

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
  assert.equal(cajero.find((r) => r.type === 'patient').detail, '0102030405');

  const doctor = ok(await H.runController(
    patients.searchReferralCandidates, H.mockReq(clinicId, userId, {}, { role: 'doctor', query: { q: 'ANA' } })
  ));
  const fila = doctor.find((r) => r.type === 'patient');
  assert.ok(fila, 'sigue encontrando al paciente por su nombre');
  assert.equal(fila.detail, '', 'pero sin la cédula al lado');
});

test('P8) el OTRO valor de la ficha física se censura igual que el campo', async () => {
  // `scanImport.alternos` guarda lo que decía el papel cuando no coincide con lo
  // que hay en el sistema. Es el MISMO dato de contacto: censurar `phone` y dejar
  // ahí el teléfono sería una puerta de atrás.
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);
  patient.scanImport = {
    importadoAt: new Date(),
    alternos: [
      { campo: 'cedula', valor: '0102030406' },
      { campo: 'celular', valor: '0999999999' },
      { campo: 'correo', valor: 'otra@example.com' },
      { campo: 'direccion', valor: 'Otra calle' },
      { campo: 'edad', valor: '54' },
    ],
  };
  await patient.save();

  const campos = (visto) => (visto.scanImport?.alternos || []).map((a) => a.campo).sort();

  const comoAdmin = ok(await getOne(clinicId, userId, 'admin', patient._id));
  assert.deepEqual(campos(comoAdmin), ['cedula', 'celular', 'correo', 'direccion', 'edad']);

  // Quien atiende ve el correo del paciente: también el que decía el papel, que
  // es justo el que necesita comparar cuando el resultado le rebota.
  const comoDoctor = ok(await getOne(clinicId, userId, 'doctor', patient._id));
  assert.deepEqual(campos(comoDoctor), ['correo', 'edad'], 'el correo sí; la edad nunca fue de contacto');

  // Mostrador ve los tres campos de la factura: también los que dice el papel,
  // que son justo los que necesita comparar cuando no cuadran. El celular del
  // papel NO, que es el mismo teléfono que se le censura en el campo.
  const comoCajero = ok(await getOne(clinicId, userId, 'cajero', patient._id));
  assert.deepEqual(campos(comoCajero), ['cedula', 'correo', 'direccion', 'edad']);
});

/**
 * El correo se ve Y SE CORRIGE. Quien atiende es quien descubre que está mal —le
 * rebota el resultado que acaba de mandar—, así que puede arreglarlo; lo que no
 * ve (cédula, teléfono, dirección) le sigue llegando vacío y descartándose.
 */
test('P9) quien atiende corrige el correo, y sigue sin poder tocar el resto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);

  // El formulario del doctor: el correo con el valor bueno, lo demás vacío.
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, {
      email: 'ana.correcta@example.com', phone: '', cedula: '', address: '', whatsapp: '',
    }, { role: 'doctor', params: { id: String(patient._id) } })
  ));

  const enBase = await Patient.findById(patient._id);
  assert.equal(enBase.email, 'ana.correcta@example.com', 'el correo se corrige');
  assert.equal(enBase.phone, '0991112233', 'el teléfono no se borra');
  assert.equal(enBase.cedula, '0102030405', 'ni la cédula');
  assert.equal(enBase.address, 'Av. Siempre Viva 123', 'ni la dirección');
});
