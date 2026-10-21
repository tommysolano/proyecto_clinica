/**
 * SUERO QUE NO SE PUDO PONER, Y AMPOLLAS INYECTADAS DIRECTAMENTE (oct-2026).
 *
 * Enfermería solo podía decir «se administró». Faltaban dos casos de todos los
 * días:
 *
 *  1. El paciente vino pero no se le pudo poner (sin vena, presión baja…). Tiene
 *     que quedar escrito con su motivo, SIN gastar una dosis ni mover inventario:
 *     lo recetado sigue pendiente para otro día.
 *  2. Las ampollas no van en el suero, se inyectan directamente. Se descuentan
 *     igual del inventario, pero no hubo bolsa: el cloruro queda vacío.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const Product = require('../models/Product');
const User = require('../models/User');
const ctrl = require('../controllers/clinicalRecordController');
const { aplicacionesDelTurno, resumenAplicacion, fueAplicada } = require('../utils/nurseApplications');

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
  const otro = await User.create({
    name: 'Luis', email: 'enf2@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  await H.makeProduct(clinicId, { code: APIMEL.code, name: APIMEL.name, stock: 10 });
  await H.makeProduct(clinicId, { code: HIERRO.code, name: HIERRO.name, stock: 10 });

  const r = await H.runController(
    ctrl.addFollowUp,
    H.mockReq(clinicId, doctor._id, {
      descripcion: 'Anemia',
      recetaItems: [{
        name: 'Sueroterapia', quantity: 2, isSerum: true,
        serumBase: { name: 'Cloruro', volumeMl: 500 },
        serumComponents: [
          { code: APIMEL.code, name: APIMEL.name, grupo: 'ampolla', quantity: 1 },
          { code: HIERRO.code, name: HIERRO.name, grupo: 'ampolla', quantity: 2 },
        ],
      }],
    }, { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const record = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = record.followUps[record.followUps.length - 1];
  const item = fu.recetaItems.find((it) => it.isSerum);
  return { clinicId, patient, doctor, enfermero, otro, followUpId: String(fu._id), itemId: String(item._id) };
}

const params = (s, extra = {}) => ({
  patientId: String(s.patient._id), followUpId: s.followUpId, itemId: s.itemId, ...extra,
});
const linea = async (s) => {
  const r = await ClinicalRecord.findOne({ patient: s.patient._id }).lean();
  return r.followUps.find((f) => String(f._id) === s.followUpId).recetaItems.find((i) => String(i._id) === s.itemId);
};
const stockDe = async (code) => (await Product.findOne({ code }).lean())?.stock;

test('«no se pudo aplicar» queda escrito con su motivo y NO gasta dosis ni inventario', async () => {
  const s = await seed();
  const r = await H.runController(ctrl.registerSerumNotApplied, H.mockReq(s.clinicId, s.enfermero._id, {
    reason: 'No se pudo canalizar la vía', note: 'Se avisó a la doctora',
  }, { role: 'enfermero', params: params(s) }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const it = await linea(s);
  assert.equal(it.administrations.length, 0, 'no cuenta como dosis');
  assert.equal(it.noAplicaciones.length, 1);
  assert.equal(it.noAplicaciones[0].reason, 'No se pudo canalizar la vía');
  assert.equal(it.noAplicaciones[0].byName, 'Karla');
  assert.equal(await stockDe(APIMEL.code), 10, 'no sale nada del inventario');

  // Y entra al parte del turno, separado de lo aplicado.
  const record = await ClinicalRecord.findOne({ patient: s.patient._id }).lean();
  const parte = aplicacionesDelTurno(record, s.enfermero._id, null);
  assert.equal(parte.length, 1);
  assert.equal(parte[0].estado, 'no_aplicado');
  assert.equal(fueAplicada(parte[0]), false);
  assert.match(resumenAplicacion(parte[0]), /no se pudo aplicar \(No se pudo canalizar la vía\)/);
});

test('sin motivo no se registra; y solo quien lo registró (o admin) lo quita', async () => {
  const s = await seed();
  const sin = await H.runController(ctrl.registerSerumNotApplied, H.mockReq(s.clinicId, s.enfermero._id, {
    reason: '   ',
  }, { role: 'enfermero', params: params(s) }));
  assert.equal(sin.statusCode, 400);

  await H.runController(ctrl.registerSerumNotApplied, H.mockReq(s.clinicId, s.enfermero._id, {
    reason: 'Presión arterial alterada',
  }, { role: 'enfermero', params: params(s) }));
  const noId = String((await linea(s)).noAplicaciones[0]._id);

  const ajeno = await H.runController(ctrl.undoSerumNotApplied, H.mockReq(s.clinicId, s.otro._id, {}, {
    role: 'enfermero', params: params(s, { noId }),
  }));
  assert.equal(ajeno.statusCode, 403);

  const propio = await H.runController(ctrl.undoSerumNotApplied, H.mockReq(s.clinicId, s.enfermero._id, {}, {
    role: 'enfermero', params: params(s, { noId }),
  }));
  assert.equal(propio.statusCode < 400, true, JSON.stringify(propio.payload));
  assert.equal((await linea(s)).noAplicaciones.length, 0);
});

test('inyectado directamente: cuenta la dosis y deja el cloruro vacío', async () => {
  const s = await seed();
  const r = await H.runController(ctrl.administerSerum, H.mockReq(s.clinicId, s.enfermero._id, {
    via: 'directa', baseVolumeMl: 500,
  }, { role: 'enfermero', params: params(s) }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const it = await linea(s);
  assert.equal(it.administrations.length, 1, 'sí es una dosis');
  const ad = it.administrations[0];
  assert.equal(ad.via, 'directa');
  assert.equal(ad.baseVolumeMl, null, 'no hubo bolsa de cloruro');
  assert.ok(ad.components.every((c) => c.via === 'directa'));
  // Aplicar no mueve el inventario (20-10-2026): las ampollas salen al cobrar.
  assert.equal(await stockDe(APIMEL.code), 10);
  assert.equal(await stockDe(HIERRO.code), 10);

  const record = await ClinicalRecord.findOne({ patient: s.patient._id }).lean();
  const [parte] = aplicacionesDelTurno(record, s.enfermero._id, null);
  assert.match(resumenAplicacion(parte), /inyectado directamente, sin suero/);
});

test('dosis mixta: una ampolla aparte y el resto en el suero', async () => {
  const s = await seed();
  const r = await H.runController(ctrl.administerSerum, H.mockReq(s.clinicId, s.enfermero._id, {
    baseVolumeMl: 250,
    components: [
      { code: APIMEL.code, name: APIMEL.name, quantityPrescribed: 1, quantityApplied: 1, via: 'suero' },
      { code: HIERRO.code, name: HIERRO.name, quantityPrescribed: 2, quantityApplied: 2, via: 'directa' },
    ],
  }, { role: 'enfermero', params: params(s) }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const ad = (await linea(s)).administrations[0];
  assert.equal(ad.via, 'mixta');
  assert.equal(ad.baseVolumeMl, 250, 'sí hubo bolsa');
  assert.deepEqual(ad.components.map((c) => c.via), ['suero', 'directa']);
});

test('la dosis de siempre sigue siendo «en suero»', async () => {
  const s = await seed();
  await H.runController(ctrl.administerSerum, H.mockReq(s.clinicId, s.enfermero._id, {}, {
    role: 'enfermero', params: params(s),
  }));
  const ad = (await linea(s)).administrations[0];
  assert.equal(ad.via, 'suero');
  assert.equal(ad.baseVolumeMl, 500);
});

test('una línea SIN composición (la molécula es el nombre) también se registra inyectada directamente', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Luis', lastName: 'M', cedula: '0911111111' });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  const doctor = await User.create({
    name: 'Dr. Vega', email: 'vega@t.com', password: 'secreto123', clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  const enfermero = await User.create({
    name: 'Ana', email: 'ana@t.com', password: 'secreto123', clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  await H.runController(ctrl.addFollowUp, H.mockReq(clinicId, doctor._id, {
    descripcion: 'Control',
    recetaItems: [{ name: 'MEGADOSIS VITAMINA C 50ML MOL', quantity: 1, isSerum: true }],
  }, { role: 'doctor', params: { patientId: String(patient._id) } }));
  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = rec.followUps[rec.followUps.length - 1];
  const it = fu.recetaItems.find((x) => x.isSerum);
  assert.equal((it.serumComponents || []).length, 0, 'la línea no trae composición');
  const r = await H.runController(ctrl.administerSerum, H.mockReq(clinicId, enfermero._id, { via: 'directa' }, {
    role: 'enfermero', params: { patientId: String(patient._id), followUpId: String(fu._id), itemId: String(it._id) },
  }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const ad = (await ClinicalRecord.findOne({ patient: patient._id }).lean())
    .followUps.find((f) => String(f._id) === String(fu._id)).recetaItems.find((x) => x.isSerum).administrations[0];
  assert.equal(ad.via, 'directa');
  assert.equal(ad.baseVolumeMl, null);
});
