/**
 * EDITAR UN SEGUIMIENTO YA GUARDADO.
 *
 * Al guardar, la cita pasa a «completada» y el doctor se quedaba fuera: si había
 * escrito algo por error no había forma de corregirlo. Ahora puede.
 *
 * Lo que vigilan estos tests es lo que un update mal hecho destruye en silencio:
 *  1. No DUPLICA el seguimiento (editar no es volver a guardar).
 *  2. No borra las administraciones de suero. Ahí está la prueba de lo que entró
 *     por la vena de un paciente; un `$set` ingenuo de `recetaItems` la borra.
 *  3. No vuelve a crear el Tratamiento de las derivaciones.
 *  4. No descuenta el inventario dos veces, y devuelve lo que se quita.
 *  5. `createdBy` NO cambia: de él sale la firma electrónica de la receta. Quien
 *     corrige no se convierte en quien atendió.
 *  6. Solo el AUTOR o un administrador. Un doctor no reescribe la consulta de otro.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const Treatment = require('../models/Treatment');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

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

const crear = (clinicId, quien, patient, body, role = 'doctor') =>
  H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, quien._id, body, { role, params: { patientId: String(patient._id) } }),
  );

const editar = (clinicId, quien, patient, followUpId, body, role = 'doctor') =>
  H.runController(
    ctrl.updateFollowUp,
    H.mockReq(clinicId, quien._id, body, {
      role,
      params: { patientId: String(patient._id), followUpId: String(followUpId) },
    }),
  );

const ultimo = async (patientId) => {
  const rec = await ClinicalRecord.findOne({ patient: patientId }).lean();
  return { rec, fu: rec.followUps[rec.followUps.length - 1] };
};

// ───────────────────────── lo básico ─────────────────────────

test('editar corrige el texto y NO crea un seguimiento nuevo', async () => {
  const { clinicId, patient, doctor } = await seed();
  await crear(clinicId, doctor, patient, { descripcion: 'Dolor de cabeza', evolucion: 'Estable' });
  const { fu } = await ultimo(patient._id);

  const r = await editar(clinicId, doctor, patient, fu._id, {
    descripcion: 'Cefalea tensional',
    evolucion: 'Estable',
    planTratamiento: 'Reposo y control en 7 días',
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const { rec, fu: despues } = await ultimo(patient._id);
  assert.equal(rec.followUps.length, 1, 'editar no puede dejar dos consultas donde había una');
  assert.equal(despues.descripcion, 'Cefalea tensional');
  assert.equal(despues.planTratamiento, 'Reposo y control en 7 días');
});

test('queda constancia de quién corrigió, y createdBy no se toca', async () => {
  const { clinicId, userId, patient, doctor } = await seed();
  await crear(clinicId, doctor, patient, { descripcion: 'Control' });
  const { fu } = await ultimo(patient._id);

  // Corrige el ADMINISTRADOR, no el autor.
  await editar(clinicId, { _id: userId }, patient, fu._id, { descripcion: 'Control anual' }, 'admin');

  const { fu: despues } = await ultimo(patient._id);
  assert.equal(
    String(despues.createdBy), String(doctor._id),
    'la firma de la receta sale de createdBy: quien corrige no pasa a ser quien atendió',
  );
  assert.equal(String(despues.updatedBy), String(userId));
  assert.ok(despues.editedAt, 'sin fecha de edición no hay forma de saber que se tocó');
});

test('un doctor NO puede reescribir la consulta de otro doctor', async () => {
  const { clinicId, patient, doctor } = await seed();
  await crear(clinicId, doctor, patient, { descripcion: 'Control' });
  const { fu } = await ultimo(patient._id);

  const otro = await User.create({
    name: 'Dr. Otro', email: 'otro@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const r = await editar(clinicId, otro, patient, fu._id, { descripcion: 'Manipulado' });
  assert.equal(r.statusCode, 403);

  const { fu: despues } = await ultimo(patient._id);
  assert.equal(despues.descripcion, 'Control', 'y no se guardó de todos modos');
});

test('un estudio se edita sin motivo de consulta; una consulta normal no', async () => {
  const { clinicId, patient, doctor } = await seed();
  await crear(clinicId, doctor, patient, {
    kind: 'estudio',
    indicaciones: 'Hígado normal',
  });
  const { fu } = await ultimo(patient._id);
  assert.equal(fu.kind, 'estudio');

  const ok = await editar(clinicId, doctor, patient, fu._id, {
    indicaciones: 'Hígado normal. Control en 6 meses.',
  });
  assert.equal(ok.statusCode < 400, true, JSON.stringify(ok.payload));

  await crear(clinicId, doctor, patient, { descripcion: 'Consulta' });
  const { fu: consulta } = await ultimo(patient._id);
  const mal = await editar(clinicId, doctor, patient, consulta._id, { evolucion: 'Sin motivo' });
  assert.equal(mal.statusCode, 400, 'una consulta sin motivo sigue sin poder guardarse');
});

// ──────────────── lo que NO se puede destruir ────────────────

test('editar CONSERVA los sueros que enfermería ya aplicó', async () => {
  const { clinicId, patient, doctor, enfermero } = await seed();
  await crear(clinicId, doctor, patient, {
    descripcion: 'Deshidratación',
    recetaItems: [{ name: 'Suero fisiológico', quantity: 3, isSerum: true, dose: '500 ml' }],
  });
  const { fu } = await ultimo(patient._id);
  const suero = fu.recetaItems.find((it) => it.isSerum);

  // Enfermería pone dos dosis.
  for (let i = 0; i < 2; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await H.runController(
      ctrl.administerSerum,
      H.mockReq(clinicId, enfermero._id, {}, {
        role: 'enfermero',
        params: {
          patientId: String(patient._id),
          followUpId: String(fu._id),
          itemId: String(suero._id),
        },
      }),
    );
  }

  // El doctor corrige la dosis escrita en la receta.
  const r = await editar(clinicId, doctor, patient, fu._id, {
    descripcion: 'Deshidratación',
    recetaItems: [{
      _id: String(suero._id),
      name: 'Suero fisiológico',
      quantity: 3,
      isSerum: true,
      dose: '1000 ml',
    }],
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const { fu: despues } = await ultimo(patient._id);
  const suero2 = despues.recetaItems.find((it) => it.isSerum);
  assert.equal(suero2.dose, '1000 ml', 'la corrección se aplicó');
  assert.equal(
    suero2.administrations.length, 2,
    'las dosis puestas son un registro clínico: editar la receta no puede borrarlas',
  );
  assert.equal(suero2.administrations[0].byName, 'Karla');
});

test('editar no crea un segundo Tratamiento a partir de las derivaciones', async () => {
  const { clinicId, patient, doctor } = await seed();
  const servicio = await H.makeProduct(clinicId, { name: 'Fisioterapia', category: 'servicio', salePrice: 30, unlimited: true });
  await crear(clinicId, doctor, patient, {
    descripcion: 'Lumbalgia',
    derivacionItems: [{ product: servicio._id, name: 'Fisioterapia', quantity: 4 }],
  });
  assert.equal(await Treatment.countDocuments({ patient: patient._id }), 1);

  const { fu } = await ultimo(patient._id);
  await editar(clinicId, doctor, patient, fu._id, {
    descripcion: 'Lumbalgia mecánica',
    derivacionItems: [{ product: servicio._id, name: 'Fisioterapia', quantity: 4 }],
  });

  assert.equal(
    await Treatment.countDocuments({ patient: patient._id }), 1,
    'cada edición no puede abrir otro tratamiento al paciente',
  );
});

test('el inventario de un compuesto se mueve por la DIFERENCIA, no otra vez entero', async () => {
  const { clinicId, patient, doctor } = await seed();
  const ampolla = await H.makeProduct(clinicId, { name: 'Vitamina C', category: 'insumo', salePrice: 5, stock: 100 });
  const compuesto = await H.makeProduct(clinicId, {
    name: 'Cóctel vitamínico', category: 'insumo', salePrice: 40, stock: 50,
    isComposite: true,
    components: [{ product: ampolla._id, name: 'Vitamina C', quantity: 1 }],
  });

  await crear(clinicId, doctor, patient, {
    descripcion: 'Refuerzo',
    recetaItems: [{
      product: compuesto._id, name: 'Cóctel vitamínico', quantity: 2,
      componentsUsed: [{ product: ampolla._id, name: 'Vitamina C', quantity: 1 }],
    }],
  });
  assert.equal((await Product.findById(ampolla._id)).stock, 98, 'al recetar salieron 2');

  const { fu } = await ultimo(patient._id);
  const linea = fu.recetaItems[0];

  // Se corrige a 3 unidades: solo debe salir 1 más.
  await editar(clinicId, doctor, patient, fu._id, {
    descripcion: 'Refuerzo',
    recetaItems: [{
      _id: String(linea._id), product: compuesto._id, name: 'Cóctel vitamínico', quantity: 3,
      componentsUsed: [{ product: ampolla._id, name: 'Vitamina C', quantity: 1 }],
    }],
  });
  assert.equal((await Product.findById(ampolla._id)).stock, 97, 'solo la diferencia');

  // Se quita la línea entera: el stock VUELVE.
  await editar(clinicId, doctor, patient, fu._id, { descripcion: 'Refuerzo', recetaItems: [] });
  assert.equal(
    (await Product.findById(ampolla._id)).stock, 100,
    'lo que ya no está recetado tiene que volver a la percha',
  );
});

test('un signo vital que nadie midió sigue en null al editar, NUNCA en 0', async () => {
  /**
   * El formulario nace con cadena vacía, pero lo que devuelve el servidor es
   * `null`. El cliente comparaba solo contra `''`, así que al corregir un
   * seguimiento sin constantes mandaba `Number(null)` = 0 y quedaba grabado
   * T 0 °C, FC 0, peso 0… en una consulta donde no se midió nada. Y con esos
   * ceros el Score MAMÁ de ginecología puntuaba 11: rojo, «clave obstétrica».
   *
   * Este test vigila el LADO SERVIDOR: si un 0 llega, se guarda (0 no es
   * nullish), así que la única defensa es que no llegue. Aquí se comprueba lo
   * que el servidor hace con lo que sí manda hoy el cliente arreglado.
   */
  const { clinicId, patient, doctor } = await seed();
  await crear(clinicId, doctor, patient, { descripcion: 'Control sin constantes' });
  const { fu } = await ultimo(patient._id);
  assert.equal(fu.vitalSigns.temperature, null, 'nace en null');

  await editar(clinicId, doctor, patient, fu._id, {
    descripcion: 'Control anual sin constantes',
    vitalSigns: {
      hora: '10:00',
      temperature: null, heartRate: null, respiratoryRate: null,
      oxygenSaturation: null, weight: null, height: null,
      abdominalPerimeter: null, capillaryHemoglobin: null, glucose: null,
      bloodPressure: '',
    },
  });

  const { fu: despues } = await ultimo(patient._id);
  for (const k of ['temperature', 'heartRate', 'respiratoryRate', 'oxygenSaturation', 'weight', 'height']) {
    assert.equal(
      despues.vitalSigns[k], null,
      `${k}: un signo sin medir no puede acabar en 0 — se imprime en la historia clínica`,
    );
  }
});

test('editar no re-sella la HORA de unos signos vitales tomados otro día', async () => {
  const { clinicId, patient, doctor } = await seed();
  await crear(clinicId, doctor, patient, {
    descripcion: 'Control',
    vitalSigns: { hora: '09:15', temperature: 36.8, bloodPressure: '120/80' },
  });
  const { fu } = await ultimo(patient._id);
  assert.equal(fu.vitalSigns.hora, '09:15');

  // El cliente vuelve a sellar la hora en CADA guardado; al corregir, la que
  // vale es la de cuando se tomó la constante.
  await editar(clinicId, doctor, patient, fu._id, {
    descripcion: 'Control anual',
    vitalSigns: { hora: '17:42', temperature: 36.8, bloodPressure: '120/80' },
  });

  const { fu: despues } = await ultimo(patient._id);
  assert.equal(
    despues.vitalSigns.hora, '09:15',
    'la hora de la toma es la de cuando se tomó, no la de cuando se corrigió el texto',
  );
});

test('editar no toca la ficha de una especialidad que no se manda', async () => {
  const { clinicId, patient, doctor } = await seed();
  const odonto = await User.create({
    name: 'Dr. Muelas', email: 'odo@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'odontologia' }],
  });
  await crear(clinicId, odonto, patient, {
    descripcion: 'Revisión',
    odontologia: { odontograma: [{ diente: '11', estado: 'caries', caras: {} }] },
  }, 'odontologia');
  const { fu } = await ultimo(patient._id);
  assert.equal(fu.odontologia.odontograma.length, 1);

  // El administrador corrige solo el motivo: no manda el odontograma.
  const { clinicId: _c, userId } = { clinicId, userId: (await User.findOne({ email: 'odo@t.com' }))._id };
  await editar(clinicId, { _id: userId }, patient, fu._id, { descripcion: 'Revisión anual' }, 'odontologia');

  const { fu: despues } = await ultimo(patient._id);
  assert.equal(despues.descripcion, 'Revisión anual');
  assert.equal(
    despues.odontologia.odontograma.length, 1,
    'omitir la sección no puede borrar la consulta de la especialidad',
  );
});
