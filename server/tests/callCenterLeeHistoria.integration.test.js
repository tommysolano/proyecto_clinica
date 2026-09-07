/**
 * EL CALL CENTER LEE LA HISTORIA CLÍNICA (7-sep-2026), Y SOLO LA LEE.
 *
 * El paciente llama preguntando qué le recetaron, cuándo fue su última consulta
 * o si tiene que volver: eso está escrito en su ficha, y la asesora tenía que
 * interrumpir a un doctor para contestarlo. Ahora entra por «Ver ficha clínica»
 * y ve la historia entera.
 *
 * Lo que fijan estos tests:
 *   1. lee la ficha y sus seguimientos;
 *   2. mirar una ficha que no existe NO la crea (consultar no abre historias);
 *   3. no puede escribir, ni corregir, ni administrar nada;
 *   4. y sigue sin ver lo reservado: ni datos de contacto ni la consulta del
 *      terapeuta.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const records = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
    phone: '0991234567', address: 'Calle Larga 123',
  });
  return { clinicId, userId, patient };
}

const req = (clinicId, userId, body, patientId, role = 'call_center') =>
  H.mockReq(clinicId, userId, body, { role, params: { patientId: String(patientId) } });

test('el call center abre la ficha y ve los seguimientos', async () => {
  const { clinicId, userId, patient } = await seed();
  await ClinicalRecord.create({
    clinic: clinicId,
    patient: patient._id,
    createdBy: userId,
    alergias: 'Penicilina',
    followUps: [{
      fecha: new Date(),
      motivoConsulta: 'Dolor de cabeza',
      descripcion: 'Dolor de cabeza',
      createdBy: userId,
      createdByRole: 'doctor',
      recetaItems: [{ name: 'Ibuprofeno 400mg', quantity: 1 }],
    }],
  });

  const r = await H.runController(records.getOrCreateByPatient, req(clinicId, userId, {}, patient._id));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  assert.equal(r.payload.followUps.length, 1);
  assert.equal(r.payload.followUps[0].recetaItems[0].name, 'Ibuprofeno 400mg', 've la receta');
  assert.equal(r.payload.alergias, 'Penicilina', 've los antecedentes');
});

test('consultar una ficha que no existe NO la crea', async () => {
  const { clinicId, userId, patient } = await seed();

  const r = await H.runController(records.getOrCreateByPatient, req(clinicId, userId, {}, patient._id));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  assert.deepEqual(r.payload.followUps, [], 'en pantalla se ve la ficha vacía');
  assert.equal(await ClinicalRecord.countDocuments({}), 0, 'pero no queda nada guardado');

  // Quien SÍ escribe la ficha sigue creándola al abrirla, como siempre.
  const delDoctor = await H.runController(
    records.getOrCreateByPatient, req(clinicId, userId, {}, patient._id, 'doctor')
  );
  assert.equal(delDoctor.statusCode < 400, true, JSON.stringify(delDoctor.payload));
  assert.equal(await ClinicalRecord.countDocuments({}), 1);
});

test('no ve los datos de contacto ni la consulta del terapeuta', async () => {
  const { clinicId, userId, patient } = await seed();
  await ClinicalRecord.create({
    clinic: clinicId,
    patient: patient._id,
    createdBy: userId,
    cedula: '0102030405',
    celular: '0991234567',
    direccion: 'Calle Larga 123',
    fichaTerapia: { motivoConsulta: 'lo que contó en terapia' },
    followUps: [{
      fecha: new Date(),
      motivoConsulta: 'sesión de terapia',
      descripcion: 'lo que se habló',
      createdBy: userId,
      createdByRole: 'terapeuta',
    }],
  });

  const r = await H.runController(records.getOrCreateByPatient, req(clinicId, userId, {}, patient._id));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  assert.equal(r.payload.cedula, undefined, 'la cédula es del administrador');
  assert.equal(r.payload.celular, undefined);
  assert.equal(r.payload.fichaTerapia, undefined, 'la ficha del terapeuta es reservada');
  assert.equal(r.payload.followUps[0].descripcion, 'Atendido por terapeuta', 'solo queda el tocón');
});

test('no escribe: la ficha y los seguimientos siguen siendo de quien atiende', async () => {
  const { clinicId, userId, patient } = await seed();
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  // Las rutas son quienes cierran la puerta (requireRole), así que se comprueban
  // sobre el router montado, no llamando al controlador a pelo.
  const rutas = require('../routes/clinicalRecords');
  const capas = rutas.stack.filter((c) => c.route);
  const ruta = (path, metodo) => capas.find((c) => c.route.path === path && c.route.methods[metodo]);

  /**
   * ¿Esta ruta deja pasar a este rol? Se ejecutan SUS guardias como las
   * ejecutaría Express (las de tres argumentos; el controlador tiene dos y no se
   * llega a él). Así se comprueba el permiso de verdad y no una lista copiada.
   */
  const dejaPasar = (capa, role) => {
    const guardias = capa.route.stack.map((h) => h.handle).filter((h) => h.length === 3);
    const req = { user: {}, role, params: {}, body: {}, query: {} };
    const res = { status: () => ({ json: () => {} }) };
    for (const guardia of guardias) {
      let siguiente = false;
      guardia(req, res, () => { siguiente = true; });
      if (!siguiente) return false;
    }
    return true;
  };

  assert.equal(dejaPasar(ruta('/:patientId', 'get'), 'call_center'), true, 'lee la ficha');
  assert.equal(dejaPasar(ruta('/:patientId', 'put'), 'call_center'), false, 'no edita la ficha');
  assert.equal(
    dejaPasar(ruta('/:patientId/follow-ups', 'post'), 'call_center'), false,
    'no escribe seguimientos'
  );
  assert.equal(
    dejaPasar(ruta('/:patientId/follow-ups/:followUpId', 'put'), 'call_center'), false,
    'no corrige seguimientos'
  );
  assert.equal(
    dejaPasar(ruta('/:patientId/follow-ups/:followUpId/receta/:itemId/administer', 'post'), 'call_center'),
    false,
    'no administra sueros'
  );
  // Y quien atiende sigue entrando por donde siempre.
  assert.equal(dejaPasar(ruta('/:patientId/follow-ups', 'post'), 'doctor'), true);
});
