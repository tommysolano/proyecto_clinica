/**
 * SUEROS CON COMPOSICIÓN: qué lleva la bolsa y qué se puso de verdad.
 *
 * Un suero no es una línea de receta, es una preparación: el cloruro que hace de
 * base y las ampollas y moléculas que van dentro. Antes eso se quedaba en la
 * cabeza del médico y enfermería tenía que preguntar.
 *
 * Lo que vigilan estos tests es lo que acaba en la vena del paciente y en el
 * inventario:
 *
 *  1. Que la composición se guarde tal cual y llegue ENTERA a enfermería, que es
 *     quien la prepara.
 *  2. Que enfermería pueda decir que una ampolla NO se puso —el paciente se
 *     niega— y que eso quede escrito, con su motivo, en vez de desaparecer.
 *  3. Que del inventario salga SOLO lo aplicado. Descontar lo recetado deja en
 *     el sistema una ampolla que sigue en la percha; no descontar nada deja de
 *     cuadrar el stock.
 *  4. Que deshacer una dosis devuelva EXACTAMENTE lo que esa dosis sacó.
 *  5. Que la composición no se cuele en líneas que no son sueros.
 *  6. Que el catálogo del cliente y el del servidor no se separen nunca: los
 *     códigos son con los que se busca la ampolla en el inventario.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const InventoryMovement = require('../models/InventoryMovement');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');
const catalogo = require('../constants/sueroterapia');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// Dos ampollas de verdad del catálogo: se usan sus códigos reales para que el
// test falle si alguien los cambia sin mirar el inventario.
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

/**
 * Receta un suero con cloruro de 500 ml, 1 APIMEL y 2 HIERRO.
 * `cantidad` son las DOSIS (cuántas bolsas), no las ampollas de cada una.
 */
async function recetarSueroCompuesto(clinicId, doctor, patient, cantidad = 2) {
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Anemia',
      recetaItems: [
        {
          name: 'Sueroterapia',
          quantity: cantidad,
          isSerum: true,
          instructions: 'Pasar en 45 minutos, vigilar la vía',
          serumBase: { name: 'Cloruro', volumeMl: 500 },
          serumComponents: [
            { code: APIMEL.code, name: APIMEL.name, grupo: 'ampolla', quantity: 1 },
            { code: HIERRO.code, name: HIERRO.name, grupo: 'ampolla', quantity: 2 },
          ],
        },
      ],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = record.followUps[record.followUps.length - 1];
  const suero = fu.recetaItems.find((it) => it.isSerum);
  assert.ok(suero, 'la línea quedó marcada como suero');
  return { followUpId: String(fu._id), itemId: String(suero._id), suero };
}

const administrar = (clinicId, quien, role, patient, followUpId, itemId, body = {}) =>
  H.runController(
    ctrl.administerSerum,
    H.mockReq(clinicId, quien._id, body, {
      role, params: { patientId: String(patient._id), followUpId, itemId },
    }),
  );

const deshacer = (clinicId, quien, role, patient, followUpId, itemId) =>
  H.runController(
    ctrl.undoSerumAdministration,
    H.mockReq(clinicId, quien._id, {}, {
      role, params: { patientId: String(patient._id), followUpId, itemId },
    }),
  );

const stockDe = async (code) => (await Product.findOne({ code }).lean())?.stock;

// ───────────────────── recetar la preparación ─────────────────────

test('el doctor receta el cloruro y las ampollas, y se guardan tal cual', async () => {
  const { clinicId, patient, doctor } = await seed();
  const { suero } = await recetarSueroCompuesto(clinicId, doctor, patient, 3);

  assert.equal(suero.serumBase.name, 'Cloruro');
  assert.equal(suero.serumBase.volumeMl, 500);
  assert.equal(suero.serumComponents.length, 2);
  assert.deepEqual(
    suero.serumComponents.map((c) => [c.code, c.name, c.quantity, c.grupo]),
    [
      [APIMEL.code, APIMEL.name, 1, 'ampolla'],
      [HIERRO.code, HIERRO.name, 2, 'ampolla'],
    ],
  );
});

test('un volumen de cloruro que no existe no se guarda', async () => {
  const { clinicId, patient, doctor } = await seed();
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Control',
      recetaItems: [{
        name: 'Suero', quantity: 1, isSerum: true,
        // 750 ml no es una bolsa que exista en la nevera.
        serumBase: { name: 'Cloruro', volumeMl: 750 },
        serumComponents: [],
      }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201);
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suero = record.followUps[0].recetaItems.find((it) => it.isSerum);
  assert.equal(suero.serumBase.volumeMl, null, 'un volumen inventado queda sin consignar');
});

test('el nombre de la ampolla se corrige con el del catálogo', async () => {
  const { clinicId, patient, doctor } = await seed();
  await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Control',
      recetaItems: [{
        name: 'Suero', quantity: 1, isSerum: true,
        serumBase: { volumeMl: 250 },
        serumComponents: [
          // Escrito a mano, en minúsculas y con acento de más: es la misma.
          { name: 'ápimel 2ml amp', quantity: 1 },
          // Esta no está en el catálogo: se receta igual, pero sin código.
          { name: 'Vitamina inventada', quantity: 3 },
        ],
      }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suero = record.followUps[0].recetaItems.find((it) => it.isSerum);
  assert.deepEqual(
    suero.serumComponents.map((c) => [c.code, c.name]),
    [[APIMEL.code, APIMEL.name], ['', 'Vitamina inventada']],
    'lo del catálogo se normaliza; lo escrito a mano se respeta sin código',
  );
});

test('una línea que NO es suero no se queda con la composición', async () => {
  const { clinicId, patient, doctor } = await seed();
  await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Control',
      recetaItems: [{
        name: 'Paracetamol', quantity: 10, isSerum: false,
        serumBase: { volumeMl: 500 },
        serumComponents: [{ code: APIMEL.code, name: APIMEL.name, quantity: 1 }],
      }],
      derivacionItems: [{
        name: 'Fisioterapia', quantity: 4, isSerum: true,
        serumBase: { volumeMl: 1000 },
        serumComponents: [{ code: HIERRO.code, name: HIERRO.name, quantity: 1 }],
      }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const items = record.followUps[0].recetaItems;
  for (const it of items) {
    assert.equal(it.isSerum, false, `${it.name} no es un suero`);
    assert.equal(it.serumBase?.volumeMl ?? null, null, `${it.name} no arrastra cloruro`);
    assert.equal((it.serumComponents || []).length, 0, `${it.name} no arrastra ampollas`);
  }
});

// ───────────────────── aplicar y descontar ─────────────────────

test('al aplicarlo entero sale del inventario todo lo recetado', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 10 });
  const { followUpId, itemId } = await recetarSueroCompuesto(clinicId, doctor, patient, 2);

  // Recetar NO descuenta: hasta que el suero no se pone, la ampolla sigue en la percha.
  assert.equal(await stockDe(APIMEL.code), 10);
  assert.equal(await stockDe(HIERRO.code), 10);

  const r = await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId, {
    components: [
      { code: APIMEL.code, quantityApplied: 1 },
      { code: HIERRO.code, quantityApplied: 2 },
    ],
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  assert.equal(await stockDe(APIMEL.code), 9, 'salió 1 APIMEL');
  assert.equal(await stockDe(HIERRO.code), 8, 'salieron 2 HIERRO');

  const movs = await InventoryMovement.find({ clinic: clinicId, type: 'salida' }).lean();
  assert.equal(movs.length, 2, 'un movimiento de inventario por ampolla');
  assert.ok(movs.every((m) => m.sourceModel === 'ClinicalRecord'), 'trazables a la ficha');
});

test('la ampolla que el paciente rechaza NO se descuenta y queda escrita', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 10 });
  const { followUpId, itemId } = await recetarSueroCompuesto(clinicId, doctor, patient, 2);

  const r = await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId, {
    components: [
      { code: APIMEL.code, quantityApplied: 1 },
      { code: HIERRO.code, quantityApplied: 0, omitReason: 'El paciente no la quiso' },
    ],
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  assert.equal(await stockDe(APIMEL.code), 9, 'la que se puso sí sale del inventario');
  assert.equal(await stockDe(HIERRO.code), 10, 'la que NO se puso sigue en la percha');

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suero = record.followUps[0].recetaItems.find((it) => it.isSerum);
  const dosis = suero.administrations[0];
  const hierro = dosis.components.find((c) => c.code === HIERRO.code);
  assert.equal(hierro.quantityPrescribed, 2, 'se recetaron 2');
  assert.equal(hierro.quantityApplied, 0, 'no se puso ninguna');
  assert.equal(hierro.omitReason, 'El paciente no la quiso', 'y consta por qué');
  assert.equal(dosis.baseVolumeMl, 500, 'el cloruro de la dosis queda registrado');
});

test('se puede poner solo parte de lo recetado de una ampolla', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 10 });
  const { followUpId, itemId } = await recetarSueroCompuesto(clinicId, doctor, patient, 2);

  await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId, {
    components: [
      { code: APIMEL.code, quantityApplied: 1 },
      { code: HIERRO.code, quantityApplied: 1, omitReason: 'Solo toleró una' },
    ],
  });
  assert.equal(await stockDe(HIERRO.code), 9, 'sale 1 de las 2 recetadas');

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const dosis = record.followUps[0].recetaItems.find((it) => it.isSerum).administrations[0];
  const hierro = dosis.components.find((c) => c.code === HIERRO.code);
  assert.equal(hierro.quantityApplied, 1);
  assert.equal(hierro.omitReason, 'Solo toleró una');
});

test('no se puede aplicar MÁS de lo que el médico recetó de una ampolla', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 10 });
  const { followUpId, itemId } = await recetarSueroCompuesto(clinicId, doctor, patient, 2);

  await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId, {
    components: [
      { code: APIMEL.code, quantityApplied: 99 },
      { code: HIERRO.code, quantityApplied: 2 },
    ],
  });

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const dosis = record.followUps[0].recetaItems.find((it) => it.isSerum).administrations[0];
  const apimel = dosis.components.find((c) => c.code === APIMEL.code);
  assert.equal(apimel.quantityApplied, 1, 'se topa en lo recetado: para más hace falta otra receta');
  assert.equal(await stockDe(APIMEL.code), 9, 'y del inventario sale solo 1');
});

test('una ampolla que no está en el inventario se aplica igual, sin mover stock', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  // Solo se da de alta APIMEL: HIERRO no existe como producto.
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 4 });
  const { followUpId, itemId } = await recetarSueroCompuesto(clinicId, doctor, patient, 1);

  const r = await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId, {
    components: [
      { code: APIMEL.code, quantityApplied: 1 },
      { code: HIERRO.code, quantityApplied: 2 },
    ],
  });
  assert.equal(r.statusCode < 400, true, 'enfermería no se queda sin poner el suero');
  assert.equal(await stockDe(APIMEL.code), 3);

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const dosis = record.followUps[0].recetaItems.find((it) => it.isSerum).administrations[0];
  assert.equal(dosis.components.find((c) => c.code === HIERRO.code).quantityApplied, 2,
    'consta que se puso, aunque no haya producto que descontar');
  assert.equal(dosis.stockMoves.length, 1, 'solo movió el inventario la que sí existe');
});

test('una ampolla de otra sucursal también se descuenta (el catálogo es de toda la organización)', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  // Dada de alta por OTRA sede y sin restricción de sucursales: se ofrece en todas.
  const otraSede = new H.mongoose.Types.ObjectId();
  await H.makeProduct(otraSede, { code: APIMEL.code, name: APIMEL.name, stock: 5, availableInClinics: [] });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 5 });
  const { followUpId, itemId } = await recetarSueroCompuesto(clinicId, doctor, patient, 1);

  await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId, {
    components: [
      { code: APIMEL.code, quantityApplied: 1 },
      { code: HIERRO.code, quantityApplied: 2 },
    ],
  });
  assert.equal(await stockDe(APIMEL.code), 4, 'se encontró aunque la creara otra sede');
  assert.equal(await stockDe(HIERRO.code), 3);
});

// ───────────────────── deshacer ─────────────────────

test('deshacer devuelve al inventario EXACTAMENTE lo que salió', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 10 });
  const { followUpId, itemId } = await recetarSueroCompuesto(clinicId, doctor, patient, 2);

  await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId, {
    components: [
      { code: APIMEL.code, quantityApplied: 1 },
      { code: HIERRO.code, quantityApplied: 0, omitReason: 'No la quiso' },
    ],
  });
  assert.equal(await stockDe(APIMEL.code), 9);
  assert.equal(await stockDe(HIERRO.code), 10);

  const r = await deshacer(clinicId, enfermero, 'enfermero', patient, followUpId, itemId);
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  assert.equal(await stockDe(APIMEL.code), 10, 'vuelve lo que se puso');
  assert.equal(await stockDe(HIERRO.code), 10, 'y lo que nunca salió no se duplica');

  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const suero = record.followUps[0].recetaItems.find((it) => it.isSerum);
  assert.equal(suero.administrations.length, 0, 'la dosis desaparece del registro');

  const entradas = await InventoryMovement.find({ clinic: clinicId, type: 'entrada' }).lean();
  assert.equal(entradas.length, 1, 'el reverso queda como movimiento, no borra el original');
});

// ───────────────────── retrocompatibilidad ─────────────────────

test('un suero SIN composición se sigue administrando como siempre', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Deshidratación',
      recetaItems: [{ name: 'Suero fisiológico', quantity: 3, isSerum: true }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201);
  let record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = record.followUps[0];
  const suero = fu.recetaItems.find((it) => it.isSerum);

  // Sin `components` en el cuerpo: es lo que manda un cliente que no se ha
  // recargado todavía.
  const a = await administrar(clinicId, enfermero, 'enfermero', patient, String(fu._id), String(suero._id));
  assert.equal(a.statusCode < 400, true, JSON.stringify(a.payload));

  record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const dosis = record.followUps[0].recetaItems.find((it) => it.isSerum).administrations;
  assert.equal(dosis.length, 1, 'se registró igual');
  assert.equal(dosis[0].components.length, 0, 'sin composición no hay nada que detallar');
  assert.equal(dosis[0].byName, 'Karla', 'y sigue constando quién lo puso');
});

test('sin mandar componentes se asume que se puso TODO lo recetado', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 10 });
  const { followUpId, itemId } = await recetarSueroCompuesto(clinicId, doctor, patient, 1);

  await administrar(clinicId, enfermero, 'enfermero', patient, followUpId, itemId);

  assert.equal(await stockDe(APIMEL.code), 9);
  assert.equal(await stockDe(HIERRO.code), 8);
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const dosis = record.followUps[0].recetaItems.find((it) => it.isSerum).administrations[0];
  assert.ok(dosis.components.every((c) => c.quantityApplied === c.quantityPrescribed));
});

// ───────────────────── lo que ve enfermería ─────────────────────

test('a enfermería le llega la preparación entera del suero', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await recetarSueroCompuesto(clinicId, doctor, patient, 2);

  const r = await H.runController(
    ctrl.getOrCreateByPatient,
    H.mockReq(clinicId, enfermero._id, {}, {
      role: 'enfermero', params: { patientId: String(patient._id) },
    }),
  );
  assert.equal(r.statusCode < 400, true);
  const suero = r.payload.followUps[0].recetaItems.find((it) => it.isSerum);
  assert.equal(suero.serumBase.volumeMl, 500, 've el cloruro');
  assert.equal(suero.serumComponents.length, 2, 've las ampollas');
  assert.deepEqual(suero.serumComponents.map((c) => c.name), [APIMEL.name, HIERRO.name]);
  assert.equal(suero.instructions, 'Pasar en 45 minutos, vigilar la vía', 've las indicaciones');
  assert.equal(suero.quantity, 2, 'y cuántas dosis se recetaron');
});

// ───────────────────── el catálogo ─────────────────────

test('el catálogo del cliente es idéntico al del servidor', async () => {
  // Los códigos son con los que se busca la ampolla en el inventario: si las dos
  // listas se separan, el doctor receta una cosa y el stock descuenta otra.
  const ruta = path.join(__dirname, '..', '..', 'client', 'src', 'constants', 'sueroterapia.js');
  const src = fs.readFileSync(ruta, 'utf8').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  const cliente = new Function(`${src}
    return { SUERO_AMPOLLAS, SUERO_MOLECULAS, SUERO_CLORURO_VOLUMENES, SUERO_CLORURO_NOMBRE };`)();

  assert.deepEqual(cliente.SUERO_AMPOLLAS, catalogo.SUERO_AMPOLLAS);
  assert.deepEqual(cliente.SUERO_MOLECULAS, catalogo.SUERO_MOLECULAS);
  assert.deepEqual(cliente.SUERO_CLORURO_VOLUMENES, catalogo.SUERO_CLORURO_VOLUMENES);
  assert.equal(cliente.SUERO_CLORURO_NOMBRE, catalogo.SUERO_CLORURO_NOMBRE);
});

test('no hay códigos repetidos en el catálogo', async () => {
  // Un código duplicado descontaría del producto equivocado.
  const codes = catalogo.SUERO_COMPONENTES.map((c) => c.code);
  assert.deepEqual(codes.filter((c, i) => codes.indexOf(c) !== i), []);
  assert.ok(codes.every(Boolean), 'ninguno se quedó sin código');
});

test('la misma ampolla recetada dos veces se cuenta por separado', async () => {
  // Recetar "APIMEL ×1" y "APIMEL ×2" en la misma bolsa es legítimo. Si el cruce
  // se hiciera solo por código, las dos filas leerían la misma casilla y se
  // descontaría de menos (o de más).
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
  let record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = record.followUps[0];
  const suero = fu.recetaItems.find((it) => it.isSerum);

  // Se pone la primera entera y de la segunda ninguna.
  await administrar(clinicId, enfermero, 'enfermero', patient, String(fu._id), String(suero._id), {
    components: [
      { code: APIMEL.code, quantityApplied: 1 },
      { code: APIMEL.code, quantityApplied: 0, omitReason: 'No la quiso' },
    ],
  });

  record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const dosis = record.followUps[0].recetaItems.find((it) => it.isSerum).administrations[0];
  assert.deepEqual(
    dosis.components.map((c) => [c.quantityPrescribed, c.quantityApplied]),
    [[1, 1], [2, 0]],
    'cada fila conserva la suya',
  );
  assert.equal(await stockDe(APIMEL.code), 9, 'sale solo la que se puso');
});
