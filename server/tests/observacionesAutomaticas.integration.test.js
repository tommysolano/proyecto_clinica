/**
 * OBSERVACIONES AUTOMÁTICAS: la bitácora del paciente se escribe sola con la
 * RECETA de cada seguimiento y cada COMPRA (oct-2026: ya no con cada visita ni
 * con los datos de caja). Ver utils/observacionesAutomaticas.js.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const PatientObservation = require('../models/PatientObservation');
const ClinicalRecord = require('../models/ClinicalRecord');
const records = require('../controllers/clinicalRecordController');
const appt = require('../controllers/appointmentController');
const sales = require('../controllers/saleController');
const observations = require('../controllers/patientObservationController');
const { asignarTurnos } = require('../utils/appointmentTurns');
const { registrarVenta } = require('../utils/observacionesAutomaticas');

test.before(async () => { await H.startDb(); await PatientObservation.createIndexes(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); await PatientObservation.createIndexes(); });

async function seed() {
  const { clinicId } = await H.seedClinic();
  const crear = (name, role) => User.create({
    name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
    clinics: [{ clinic: clinicId, role }],
  });
  const caja = await crear('Carla', 'cajero');
  const admin = await crear('Admin', 'admin');
  const doc = await crear('Doctora', 'doctor');
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  return { clinicId, caja, admin, doc, patient };
}

/** Los registros se escriben sin esperar a la respuesta: se espera a que aparezcan. */
async function esperarObs(filtro, cumple = () => true, ms = 3000) {
  const fin = Date.now() + ms;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const o = await PatientObservation.findOne(filtro).lean();
    if (o && cumple(o)) return o;
    if (Date.now() > fin) return o;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('1 · la cita atendida YA NO escribe una observación de visita (oct-2026)', async () => {
  const { clinicId, caja, doc, patient } = await seed();
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00',
    status: 'asistida', serviceName: 'Limpieza dental',
  });
  asignarTurnos(cita, { pasos: [{ kind: 'doctor', user: doc._id }] });
  cita.turns[0].status = 'completado';
  cita.status = 'completada';
  await cita.save();

  const r = await H.runController(appt.updateServiceAndValue, H.mockReq(clinicId, caja._id, {
    agreedValue: 35, advancePayment: 'abono', advanceAmount: 10, advanceMethod: 'transferencia',
  }, { role: 'cajero', params: { id: String(cita._id) } }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(await PatientObservation.countDocuments({}), 0, 'ni visita ni cobro de la cita');
});

test('1b · «No pagó aún»: la cita NO queda como cobrada por quien la agendó', async () => {
  const { clinicId, caja, patient } = await seed();
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'asistida',
    // Venía marcada como pagada por error: al corregirla, el «Cobró» se va.
    advancePayment: 'total', chargeRegisteredBy: caja._id, chargeRegisteredByName: 'Carla', chargeRegisteredAt: new Date(),
  });
  const r = await H.runController(appt.updateServiceAndValue, H.mockReq(clinicId, caja._id, {
    agreedValue: 20, advancePayment: '',
  }, { role: 'cajero', params: { id: String(cita._id) } }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.chargeRegisteredBy, null);
  assert.equal(guardada.chargeRegisteredByName, '');
  assert.equal(String(guardada.valueSetBy), String(caja._id), 'quién puso el valor sigue constando');
});

test('2 · la RECETA queda en Observaciones; corregirla la reescribe y quitarla la borra', async () => {
  const { clinicId, doc, patient } = await seed();
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: doc._id });
  const r = await H.runController(records.addFollowUp, H.mockReq(clinicId, doc._id, {
    motivoConsulta: 'Dolor de cabeza',
    recetaItems: [
      { name: 'Paracetamol 500 mg', quantity: 10, dose: '1 tableta', frequency: 'cada 8 h', duration: '3 días' },
    ],
  }, { role: 'doctor', params: { patientId: String(patient._id) } }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const fuId = r.payload.followUps.slice(-1)[0]._id;

  const obs = await esperarObs({ 'auto.kind': 'receta', 'auto.ref': fuId });
  assert.ok(obs, 'se escribió la observación de la receta');
  assert.equal(String(obs.patient), String(patient._id));
  assert.match(obs.text, /^Receta · /);
  assert.match(obs.text, /Doctora/);
  assert.match(obs.text, /• Paracetamol 500 mg × 10 · 1 tableta · cada 8 h · 3 días/);

  // Se corrige la receta: la constancia se reescribe, no se duplica.
  const editar = (recetaItems) => H.runController(records.updateFollowUp, H.mockReq(clinicId, doc._id, {
    motivoConsulta: 'Dolor de cabeza', recetaItems,
  }, { role: 'doctor', params: { patientId: String(patient._id), followUpId: String(fuId) } }));
  const e1 = await editar([{ name: 'Ibuprofeno 400 mg', quantity: 6 }]);
  assert.equal(e1.statusCode < 400, true, JSON.stringify(e1.payload));
  const corregida = await esperarObs({ 'auto.kind': 'receta', 'auto.ref': fuId }, (o) => /Ibuprofeno/.test(o.text));
  assert.match(corregida.text, /Ibuprofeno 400 mg × 6/);
  assert.doesNotMatch(corregida.text, /Paracetamol/);
  assert.equal(await PatientObservation.countDocuments({ 'auto.kind': 'receta' }), 1);

  // Sin receta: la constancia se va.
  const e2 = await editar([]);
  assert.equal(e2.statusCode < 400, true, JSON.stringify(e2.payload));
  const fin = Date.now() + 3000;
  // eslint-disable-next-line no-await-in-loop
  while (await PatientObservation.countDocuments({ 'auto.kind': 'receta' }) && Date.now() < fin) {
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 50));
  }
  assert.equal(await PatientObservation.countDocuments({ 'auto.kind': 'receta' }), 0);
});

test('2b · un seguimiento SIN receta no escribe nada', async () => {
  const { clinicId, doc, patient } = await seed();
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: doc._id });
  const r = await H.runController(records.addFollowUp, H.mockReq(clinicId, doc._id, {
    motivoConsulta: 'Control', recetaItems: [],
  }, { role: 'doctor', params: { patientId: String(patient._id) } }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(await PatientObservation.countDocuments({}), 0);
});

test('3 · la COMPRA queda en Observaciones (qué y cuánto, sin datos de caja) y dice si se anuló', async () => {
  const { clinicId, caja, patient } = await seed();
  const servicio = await H.makeProduct(clinicId, {
    name: 'Consulta general', category: 'servicio', unlimited: true, salePrice: 25,
  });
  const r = await H.runController(sales.createSale, H.mockReq(clinicId, caja._id, {
    date: H.docDate(), paymentMethod: 'efectivo', patient: String(patient._id),
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 25 }],
  }, { role: 'cajero' }));
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  const saleId = r.payload._id;

  const obs = await esperarObs({ 'auto.kind': 'venta', 'auto.ref': saleId });
  assert.ok(obs, 'se escribió la observación de la compra');
  assert.match(obs.text, /^Compra · /);
  assert.match(obs.text, /Consulta general × 1 \(servicio\)/);
  assert.match(obs.text, /Total: \$25\.00/);
  assert.doesNotMatch(obs.text, /Forma de pago|Cobrado por/);

  const an = await H.runController(sales.cancelSale, H.mockReq(clinicId, caja._id, {}, {
    role: 'cajero', params: { id: String(saleId) },
  }));
  assert.equal(an.statusCode < 400, true, JSON.stringify(an.payload));
  const anulada = await esperarObs({ 'auto.kind': 'venta', 'auto.ref': saleId }, (o) => /ANULADA/.test(o.text));
  assert.match(anulada.text, /Compra ANULADA/);
  assert.equal(await PatientObservation.countDocuments({ 'auto.kind': 'venta' }), 1);
});

test('4 · el registro automático no lo reescribe quien figura como autor; el admin sí', async () => {
  const { clinicId, caja, admin, patient } = await seed();
  const servicio = await H.makeProduct(clinicId, { category: 'servicio', unlimited: true, salePrice: 10 });
  const r = await H.runController(sales.createSale, H.mockReq(clinicId, caja._id, {
    date: H.docDate(), paymentMethod: 'efectivo', patient: String(patient._id),
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 10 }],
  }, { role: 'cajero' }));
  await registrarVenta(r.payload._id, caja._id);
  const obs = await PatientObservation.findOne({ 'auto.kind': 'venta' }).lean();
  const params = { id: String(patient._id), obsId: String(obs._id) };

  const deCaja = await H.runController(observations.update, H.mockReq(clinicId, caja._id, { text: 'otro' }, {
    role: 'cajero', params,
  }));
  assert.equal(deCaja.statusCode, 403);

  const deAdmin = await H.runController(observations.update, H.mockReq(clinicId, admin._id, { text: 'corregido' }, {
    role: 'admin', params,
  }));
  assert.equal(deAdmin.statusCode < 400, true, JSON.stringify(deAdmin.payload));
});
