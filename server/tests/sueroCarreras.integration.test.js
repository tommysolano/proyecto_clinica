/**
 * SUEROS: CARRERAS, TOPES Y STOCK QUE NO CUADRA.
 *
 * Estos casos salieron de una revisión adversarial del cambio y todos tocan el
 * inventario, que es donde un error no se nota hasta que falta una ampolla:
 *
 *  1. Deshacer dos veces devolvía el stock DOS veces (el botón no espera
 *     respuesta, así que dos clics mandan dos DELETE).
 *  2. Dos peticiones simultáneas se saltaban el tope de dosis recetadas.
 *  3. Con menos stock del recetado se anotaba lo PEDIDO y no lo que salió, así
 *     que deshacer creaba inventario de la nada.
 *  4. La ampolla se descontaba de la sucursal equivocada cuando dos sedes tienen
 *     el mismo código.
 *  5. El único nombre duplicado del catálogo guardaba el código dado de baja, y
 *     entonces no se descontaba nada.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const APIMEL = { code: 'AAPL01', name: 'APIMEL 2ML AMP' };
const HIERRO = { code: 'PTHIERR01', name: 'HIERRO 2ML AMP' };

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  const doctor = await User.create({
    name: 'Dra. Salas', email: 'doc@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const enfermero = await User.create({
    name: 'Karla', email: 'enf@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  return { clinicId, userId, patient, doctor, enfermero };
}

/** Suero con cloruro 500 ml, 1 APIMEL y 2 HIERRO. `cantidad` = dosis. */
async function recetarSuero(clinicId, doctor, patient, cantidad = 2) {
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Anemia',
      recetaItems: [{
        name: 'Sueroterapia', quantity: cantidad, isSerum: true,
        serumBase: { name: 'Cloruro', volumeMl: 500 },
        serumComponents: [
          { code: APIMEL.code, name: APIMEL.name, quantity: 1 },
          { code: HIERRO.code, name: HIERRO.name, quantity: 2 },
        ],
      }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = record.followUps[record.followUps.length - 1];
  const suero = fu.recetaItems.find((it) => it.isSerum);
  return { followUpId: String(fu._id), itemId: String(suero._id) };
}

const administrar = (clinicId, quien, patient, followUpId, itemId, body = {}) =>
  H.runController(
    ctrl.administerSerum,
    H.mockReq(clinicId, quien._id, body, {
      role: 'enfermero', params: { patientId: String(patient._id), followUpId, itemId },
    }),
  );

const deshacer = (clinicId, quien, patient, followUpId, itemId) =>
  H.runController(
    ctrl.undoSerumAdministration,
    H.mockReq(clinicId, quien._id, {}, {
      role: 'enfermero', params: { patientId: String(patient._id), followUpId, itemId },
    }),
  );

const stockDe = async (code, clinic) =>
  (await Product.findOne(clinic ? { code, clinic } : { code }).lean())?.stock;

const TODO = {
  components: [
    { code: APIMEL.code, quantityApplied: 1 },
    { code: HIERRO.code, quantityApplied: 2 },
  ],
};

// ───────────────────── carreras ─────────────────────

test('deshacer DOS veces no devuelve el stock dos veces', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 10 });
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 2);

  await administrar(clinicId, enfermero, patient, followUpId, itemId, TODO);
  assert.equal(await stockDe(APIMEL.code), 9);

  const dos = await Promise.all([
    deshacer(clinicId, enfermero, patient, followUpId, itemId),
    deshacer(clinicId, enfermero, patient, followUpId, itemId),
  ]);
  assert.equal(dos.filter((r) => r.statusCode < 400).length, 1, 'solo una deshace');

  assert.equal(await stockDe(APIMEL.code), 10, 'el stock vuelve a lo que era, ni una más');
  assert.equal(await stockDe(HIERRO.code), 10);
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.equal(record.followUps[0].recetaItems.find((it) => it.isSerum).administrations.length, 0);
});

test('dos peticiones a la vez no pasan del tope de dosis recetadas', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 10 });
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 1);

  const dos = await Promise.all([
    administrar(clinicId, enfermero, patient, followUpId, itemId, TODO),
    administrar(clinicId, enfermero, patient, followUpId, itemId, TODO),
  ]);
  assert.equal(dos.filter((r) => r.statusCode < 400).length, 1, 'solo una dosis entra');

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suero = record.followUps[0].recetaItems.find((it) => it.isSerum);
  assert.equal(suero.administrations.length, 1, 'una receta de 1 admite 1 aplicación');
  assert.equal(await stockDe(APIMEL.code), 9, 'y sale una sola ampolla');
  assert.equal(await stockDe(HIERRO.code), 8);
});

// ───────────────────── stock que no da ─────────────────────

test('con menos stock del recetado se descuenta lo que hay, y deshacer no lo infla', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 5 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 1 });
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 1);

  await administrar(clinicId, enfermero, patient, followUpId, itemId, TODO);
  assert.equal(await stockDe(HIERRO.code), 0, 'solo había 1, se va a 0');

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const dosis = record.followUps[0].recetaItems.find((it) => it.isSerum).administrations[0];
  assert.equal(
    dosis.components.find((c) => c.code === HIERRO.code).quantityApplied, 2,
    'clínicamente se aplicaron 2: eso no se toca',
  );
  const total = dosis.stockMoves.reduce((a, m) => a + m.quantity, 0);
  assert.equal(total, 2, 'pero el inventario solo movió 1 de HIERRO + 1 de APIMEL');

  await deshacer(clinicId, enfermero, patient, followUpId, itemId);
  assert.equal(await stockDe(HIERRO.code), 1, 'vuelve a 1, no a 2');
  assert.equal(await stockDe(APIMEL.code), 5);
});

test('una ampolla con stock 0 no crea inventario al deshacer', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 0 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 0 });
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 1);

  const r = await administrar(clinicId, enfermero, patient, followUpId, itemId, TODO);
  assert.equal(r.statusCode < 400, true, 'se aplica igual: no se bloquea a enfermería por el stock');

  await deshacer(clinicId, enfermero, patient, followUpId, itemId);
  assert.equal(await stockDe(APIMEL.code), 0, 'sigue en 0: nunca salió nada');
  assert.equal(await stockDe(HIERRO.code), 0);
});

// ───────────────────── sucursal y catálogo ─────────────────────

test('la ampolla se descuenta de la sucursal donde se aplica, no de otra', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  const otraSede = new H.mongoose.Types.ObjectId();
  await H.makeProduct(otraSede, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 4 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 4 });
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 1);

  await administrar(clinicId, enfermero, patient, followUpId, itemId, TODO);

  assert.equal(await stockDe(APIMEL.code, clinicId), 3, 'sale de la nevera de esta sede');
  assert.equal(await stockDe(APIMEL.code, otraSede), 10, 'la otra sede no se toca');
});

test('el nombre duplicado del catálogo resuelve al código VIGENTE', async () => {
  // PTNEUREG01 está dado de baja; PTNEUREG03 repone el mismo producto. El
  // buscador enseña el vigente: guardar el viejo dejaba la molécula sin
  // descontar, porque el inventario está dado de alta con el código nuevo.
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: 'PTNEUREG03', name: 'NEURO REGENERADOR 10 ML MOL ROCAB', stock: 6 });

  await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Control',
      recetaItems: [{
        name: 'Suero', quantity: 1, isSerum: true,
        serumBase: { volumeMl: 500 },
        serumComponents: [{ name: 'NEURO REGENERADOR 10 ML MOL ROCAB', quantity: 1 }],
      }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = record.followUps[0];
  const suero = fu.recetaItems.find((it) => it.isSerum);
  assert.equal(suero.serumComponents[0].code, 'PTNEUREG03', 'guarda el código vigente');

  await administrar(clinicId, enfermero, patient, String(fu._id), String(suero._id), {
    components: [{ code: 'PTNEUREG03', quantityApplied: 1 }],
  });
  assert.equal(await stockDe('PTNEUREG03'), 5, 'y por eso sí se descuenta');
});

// ───────────────────── el cloruro de la dosis ─────────────────────

test('el enfermero puede consignar el cloruro que puso de verdad', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  const { followUpId, itemId } = await recetarSuero(clinicId, doctor, patient, 1);

  await administrar(clinicId, enfermero, patient, followUpId, itemId, {
    baseVolumeMl: 250,
    ...TODO,
  });
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suero = record.followUps[0].recetaItems.find((it) => it.isSerum);
  assert.equal(suero.serumBase.volumeMl, 500, 'lo recetado no cambia');
  assert.equal(suero.administrations[0].baseVolumeMl, 250, 'y consta lo que se puso');
});

test('la misma ampolla dos veces con lista PARCIAL no descuenta de más', async () => {
  // Receta [APIMEL x1, APIMEL x2]. Si llega solo una casilla, las dos filas no
  // pueden leerla: cada casilla se consume una sola vez.
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });

  await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Control',
      recetaItems: [{
        name: 'Suero', quantity: 1, isSerum: true,
        serumBase: { volumeMl: 500 },
        serumComponents: [
          { code: APIMEL.code, name: APIMEL.name, quantity: 1 },
          { code: APIMEL.code, name: APIMEL.name, quantity: 2 },
        ],
      }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = record.followUps[0];
  const suero = fu.recetaItems.find((it) => it.isSerum);

  // Lista PARCIAL: solo una entrada para dos filas.
  await administrar(clinicId, enfermero, patient, String(fu._id), String(suero._id), {
    components: [{ code: APIMEL.code, quantityApplied: 1 }],
  });

  const r2 = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const dosis = r2.followUps[0].recetaItems.find((it) => it.isSerum).administrations[0];
  const total = dosis.components.reduce((a, c) => a + c.quantityApplied, 0);
  assert.equal(total, 1, 'solo la casilla que llegó cuenta; la otra fila queda en 0');
  assert.equal(await stockDe(APIMEL.code), 9);
});
