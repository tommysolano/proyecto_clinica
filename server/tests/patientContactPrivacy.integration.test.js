/**
 * DATOS DE CONTACTO DEL PACIENTE: cédula, dirección, teléfono, WhatsApp y correo.
 *
 * La regla es que los ve SOLO el administrador, con excepciones POR CAMPO:
 *  · MOSTRADOR ve los CINCO, uno a uno: cédula, dirección y correo son lo que
 *    lleva el comprobante electrónico (y ya los recibía al facturar con
 *    `?withContact=1`); teléfono y WhatsApp, porque recepción es quien llama
 *    para confirmar una cita o avisar de un resultado.
 *  · QUIEN ATIENDE ve el correo y la CÉDULA (`patients.email`, `patients.cedula`):
 *    por el correo manda el resultado de un examen o la receta, y la cédula es el
 *    número con el que identifica al paciente antes de escribir en su historia
 *    —va en la receta, en el pedido de laboratorio y en las hojas del MSP—.
 *    Dirección, teléfono y WhatsApp NO: ahí sigue la línea.
 *
 * Que mostrador los tenga todos NO es lo mismo que darle `patients.contactData`:
 * esa abre además la hoja MSP completa y las columnas del Excel de pacientes, que
 * siguen siendo del administrador (ver P6 y `exportPatients`). Lo que se vigila
 * aquí es que se cumpla en el SERVIDOR y no solo en React: ocultar una columna no
 * es un permiso, cualquiera abre la pestaña de red y lee el JSON.
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
// Lo que sigue sin ver NADIE fuera de admin y mostrador. La cédula salió de esta
// lista en sep-2026: la ve también quien atiende (ver P1).
const SOLO_ADMIN_Y_CAJA = ['address', 'phone', 'whatsapp'];

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
   * QUIEN ATIENDE VE EL CORREO Y LA CÉDULA, y nada más (sep-2026).
   *
   * Por el correo manda el resultado de un examen, la receta o las indicaciones.
   * La cédula la pidieron los médicos: es el número con el que se identifica al
   * paciente —y lo que distingue a dos homónimos antes de escribir en una
   * historia clínica—, además de ir en la receta y en el pedido de laboratorio.
   *
   * Se comprueban también las ESPECIALIDADES: la capacidad se concede a la clave
   * 'doctor' y `can()` mapea todas ahí; si alguien rompiera esa expansión, el
   * dato desaparecería para todas menos medicina general sin que nadie lo note.
   */
  for (const rol of ['doctor', 'odontologia', 'optica', 'ginecologia', 'terapeuta']) {
    const visto = ok(await getOne(clinicId, userId, rol, patient._id));
    assert.equal(visto.email, 'ana@example.com', `${rol} necesita el correo del paciente`);
    assert.equal(visto.cedula, '0102030405', `${rol} identifica al paciente por su cédula`);
    for (const f of ['address', 'phone', 'whatsapp']) {
      assert.equal(visto[f], undefined, `${rol} NO debe recibir ${f}`);
    }
  }

  // Y la EDAD, que no es un dato de contacto, le llega a todo el mundo: de ella
  // salen las dosis y por eso nunca se censuró.
  const comoDoctor = ok(await getOne(clinicId, userId, 'doctor', patient._id));
  assert.equal(typeof (comoDoctor.computedAge ?? comoDoctor.age), 'number', 'la edad llega calculada');

  /**
   * MOSTRADOR VE LOS CINCO (sep-2026), campo a campo y cada uno por su motivo:
   * cédula, dirección y correo son lo que va en el comprobante electrónico —y lo
   * que caja ya recibía por la otra puerta, `?withContact=1`—; teléfono y
   * WhatsApp, porque recepción es quien llama.
   */
  const comoCajero = ok(await getOne(clinicId, userId, 'cajero', patient._id));
  for (const f of CONTACT_FIELDS) {
    assert.ok(comoCajero[f], `mostrador necesita ${f}`);
  }
  assert.equal(comoCajero.cedula, '0102030405');
  assert.equal(comoCajero.phone, '0991112233');
  assert.equal(comoCajero.whatsapp, '0991112233');
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
  for (const f of CONTACT_FIELDS) {
    assert.ok(paraCajero.patients[0][f], `mostrador ve ${f} también en el listado`);
  }

  const paraDoctor = ok(await list(clinicId, userId, 'doctor'));
  for (const f of SOLO_ADMIN_Y_CAJA) {
    assert.equal(paraDoctor.patients[0][f], undefined, `el listado sigue censurando ${f} a quien atiende`);
  }
  // El correo y la cédula sí, también en el listado: es donde se busca al
  // paciente y donde se comprueba que es el que se va a atender.
  assert.equal(paraDoctor.patients[0].email, 'ana@example.com');
  assert.equal(paraDoctor.patients[0].cedula, '0102030405');

  // Nueva venta / Cotizaciones / Pagos: `withContact=1` + capacidad de facturar.
  const paraFacturar = ok(await list(clinicId, userId, 'cajero', { withContact: '1' }));
  assert.equal(paraFacturar.patients[0].cedula, '0102030405', 'sin cédula la factura sale a consumidor final');
  assert.equal(paraFacturar.patients[0].email, 'ana@example.com');

  const contable = ok(await list(clinicId, userId, 'contabilidad', { withContact: '1' }));
  assert.equal(contable.patients[0].cedula, '0102030405', 'la cartera identifica al tercero por su cédula');

  // Quien no factura no consigue nada pidiéndolo. (El doctor queda fuera de esta
  // comprobación desde sep-2026: la cédula ya la ve por su propia capacidad, así
  // que aquí no probaría nada. Lo que sí sigue sin conseguir es el teléfono, y
  // eso se comprueba justo debajo.)
  for (const rol of ['call_center', 'enfermero', 'marketing']) {
    const r = ok(await list(clinicId, userId, rol, { withContact: '1' }));
    assert.equal(r.patients[0].cedula, undefined, `${rol} no puede saltarse la regla con withContact`);
  }
  // Y el doctor tampoco lo usa para colarse en lo que NO tiene: el teléfono, el
  // WhatsApp y la dirección siguen sin llegarle, lo pida como lo pida.
  const doctorPidiendo = ok(await list(clinicId, userId, 'doctor', { withContact: '1' }));
  for (const f of SOLO_ADMIN_Y_CAJA) {
    assert.equal(doctorPidiendo.patients[0][f], undefined, `withContact no le da ${f} a quien atiende`);
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

  const doctor = ok(await list(clinicId, userId, 'doctor', { search: '0102030405' }));
  assert.equal(doctor.total, 1, 'buscar por cédula lo hace cualquiera que entre al listado');
  assert.equal(doctor.patients[0].cedula, '0102030405', 'y desde sep-2026 la ve: identifica con ella');

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

  // Mostrador ve los cinco, así que su formulario los trae rellenos y los manda
  // tal cual: aquí no hay nada que proteger de él, y sí lo hay del resto.
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, {
      firstName: 'ANA MARIA', address: 'Av. Amazonas N34-12', email: 'ana.nueva@example.com',
    }, { role: 'cajero', params: { id: String(patient._id) } })
  ));
  const corregido = await Patient.findById(patient._id);
  assert.equal(corregido.firstName, 'ANA MARIA');
  assert.equal(corregido.address, 'Av. Amazonas N34-12', 'mostrador corrige la dirección');
  assert.equal(corregido.email, 'ana.nueva@example.com', 'y el correo');
  assert.equal(corregido.phone, '0991112233', 'lo que no mandó, no se toca');

  // QUIEN NO LO VE NO LO BORRA: el formulario del call center recibe los cinco
  // campos vacíos, y sin el filtro del PUT un guardado cualquiera los vaciaría.
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, {
      firstName: 'ANA', cedula: '', phone: '', email: '', address: '', whatsapp: '',
    }, { role: 'call_center', params: { id: String(patient._id) } })
  ));
  const enBase = await Patient.findById(patient._id);
  assert.equal(enBase.firstName, 'ANA', 'lo que sí puede editar se guarda');
  assert.equal(enBase.cedula, '0102030405', 'la cédula sigue ahí');
  assert.equal(enBase.phone, '0991112233', 'el teléfono sigue ahí');
  assert.equal(enBase.whatsapp, '0991112233', 'y el WhatsApp también');
  assert.equal(enBase.email, 'ana.nueva@example.com');
  assert.equal(enBase.address, 'Av. Amazonas N34-12');

  // Y quien NO ve el teléfono tampoco lo borra al guardar (el doctor lo recibe
  // vacío, así que su formulario lo manda vacío).
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, { phone: '', address: '', firstName: 'ANA' }, { role: 'doctor', params: { id: String(patient._id) } })
  ));
  const trasElDoctor = await Patient.findById(patient._id);
  assert.equal(trasElDoctor.phone, '0991112233', 'el doctor no puede borrar el teléfono');
  assert.equal(trasElDoctor.address, 'Av. Amazonas N34-12', 'ni la dirección');

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

/**
 * La cabecera de la hoja MSP guarda su PROPIA copia de la cédula, la dirección y
 * el celular, y va censurada con las MISMAS reglas que la ficha del paciente —por
 * campo, no en bloque—. Esconderlos en /patients y dejarlos aquí sería no
 * esconderlos; censurarlos aquí en bloque era la incoherencia contraria: desde
 * sep-2026 quien atiende ve la cédula del paciente, y en su propia hoja MSP le
 * seguía saliendo en blanco.
 */
test('P6) la cabecera de la hoja MSP se censura con las mismas reglas, campo a campo', async () => {
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
  assert.equal(comoDoctor.cedula, '0102030405', 'la cédula sí: identifica al paciente que va a atender');
  assert.equal(comoDoctor.direccion, undefined, 'la dirección no');
  assert.equal(comoDoctor.celular, undefined, 'el celular tampoco');

  // Enfermería lee la historia entera y aun así no ve ninguno de los tres.
  const comoEnfermero = ok(await H.runController(
    clinicalRecords.getOrCreateByPatient, H.mockReq(clinicId, userId, {}, { role: 'enfermero', params })
  ));
  assert.equal(comoEnfermero.cedula, undefined);
  assert.equal(comoEnfermero.celular, undefined);

  // Y guardar desde ese rol no borra lo que NO ve (la dirección y el celular).
  // La cédula sí la manda su formulario, porque la tiene delante.
  ok(await H.runController(
    clinicalRecords.updateByPatient,
    H.mockReq(clinicId, userId, { cedula: '0102030405', direccion: '', celular: '', nombre: 'ANA PEREZ' }, { role: 'doctor', params })
  ));
  const ficha = await ClinicalRecord.findOne({ clinic: clinicId, patient: patient._id });
  assert.equal(ficha.cedula, '0102030405');
  assert.equal(ficha.direccion, 'Av. Siempre Viva 123', 'lo que no ve, no lo borra');
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

  // Quien atiende también la ve desde sep-2026 (capacidad `patients.cedula`).
  const doctor = ok(await H.runController(
    patients.searchReferralCandidates, H.mockReq(clinicId, userId, {}, { role: 'doctor', query: { q: 'ANA' } })
  ));
  const fila = doctor.find((r) => r.type === 'patient');
  assert.ok(fila, 'sigue encontrando al paciente por su nombre');
  assert.equal(fila.detail, '0102030405');

  // Quien NO puede verla sigue encontrando al paciente y sin la cédula al lado:
  // eso es lo que este test vigila de verdad.
  const marketing = ok(await H.runController(
    patients.searchReferralCandidates, H.mockReq(clinicId, userId, {}, { role: 'marketing', query: { q: 'ANA' } })
  ));
  const filaMkt = marketing.find((r) => r.type === 'patient');
  assert.ok(filaMkt, 'lo encuentra por el nombre');
  assert.equal(filaMkt.detail, '', 'pero sin la cédula al lado');
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

  // Quien atiende ve el correo y la cédula del paciente: también los que decía el
  // papel, que son justo los que necesita comparar cuando no cuadran (el correo,
  // si el resultado le rebota; la cédula, antes de escribir en la historia).
  const comoDoctor = ok(await getOne(clinicId, userId, 'doctor', patient._id));
  assert.deepEqual(campos(comoDoctor), ['cedula', 'correo', 'edad'], 'el teléfono y la dirección no; la edad nunca fue de contacto');

  // Mostrador ve los cinco datos de contacto: también los que dice el papel,
  // que son justo los que necesita comparar cuando no cuadran.
  const comoCajero = ok(await getOne(clinicId, userId, 'cajero', patient._id));
  assert.deepEqual(campos(comoCajero), ['cedula', 'celular', 'correo', 'direccion', 'edad']);
});

/**
 * LO QUE SE VE, SE CORRIGE; lo que no, ni se toca. Es la misma regla de siempre
 * aplicada a los dos campos que hoy tiene quien atiende: el correo —es quien
 * descubre que está mal, porque le rebota el resultado que acaba de mandar— y la
 * cédula, desde sep-2026. El teléfono y la dirección le siguen llegando vacíos y
 * descartándose, que es lo que impide que un guardado cualquiera los borre.
 */
test('P9) quien atiende corrige el correo y la cédula, y sigue sin tocar el resto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await seedPaciente(clinicId);

  // El formulario del doctor: correo y cédula con su valor, lo demás vacío.
  ok(await H.runController(
    patients.updatePatient,
    H.mockReq(clinicId, userId, {
      email: 'ana.correcta@example.com', cedula: '0999888777', phone: '', address: '', whatsapp: '',
    }, { role: 'doctor', params: { id: String(patient._id) } })
  ));

  const enBase = await Patient.findById(patient._id);
  assert.equal(enBase.email, 'ana.correcta@example.com', 'el correo se corrige');
  assert.equal(enBase.cedula, '0999888777', 'y la cédula también: la ve, así que la arregla');
  assert.equal(enBase.phone, '0991112233', 'el teléfono no se borra');
  assert.equal(enBase.whatsapp, '0991112233', 'ni el WhatsApp');
  assert.equal(enBase.address, 'Av. Siempre Viva 123', 'ni la dirección');
});
