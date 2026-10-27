const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const PatientObservation = require('../models/PatientObservation');
const User = require('../models/User');
const Clinic = require('../models/Clinic');
const Company = require('../models/Company');
const { invalidateCompanyCache } = require('../utils/companies');
const appointments = require('../controllers/appointmentController');
const users = require('../controllers/userController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId,
    firstName: 'Ana',
    lastName: 'Pérez',
    cedula: '0102030405',
  });
  const appointment = await Appointment.create({
    clinic: clinicId,
    patient: patient._id,
    date: H.docDate(),
    startTime: '10:30',
    status: 'completada',
    prescribedItems: [{ name: 'Dato anterior', quantity: 1 }],
    itemsValue: 10,
    itemsMethod: 'efectivo',
    chargeRegisteredBy: userId,
    chargeRegisteredByName: 'Caja anterior',
    chargeRegisteredAt: new Date(),
  });
  const product = await H.makeProduct(clinicId, {
    name: 'Protector solar',
    salePrice: 24.5,
    stock: 20,
  });
  return { clinicId, userId, patient, appointment, product };
}

test('registra receta y producto adicional en Observaciones y deja limpia la cita', async () => {
  const { clinicId, userId, patient, appointment, product } = await seed();

  const result = await H.runController(
    appointments.updateCobroItems,
    H.mockReq(clinicId, userId, {
      items: [
        { source: 'receta', name: 'Ibuprofeno 400 mg', quantity: 2 },
        { source: 'adicional', product: String(product._id), quantity: 3 },
      ],
      itemsValue: 79.5,
      itemsMethod: 'tarjeta_debito',
    }, { role: 'cajero', params: { id: String(appointment._id) } }),
  );

  assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
  const savedAppointment = await Appointment.findById(appointment._id).lean();
  assert.deepEqual(savedAppointment.prescribedItems, []);
  assert.equal(savedAppointment.itemsValue, null);
  assert.equal(savedAppointment.itemsMethod, '');
  assert.equal(savedAppointment.chargeRegisteredBy, null);
  assert.equal(savedAppointment.chargeRegisteredAt, null);

  const observations = await PatientObservation.find({ patient: patient._id }).lean();
  assert.equal(observations.length, 1);
  assert.equal(String(observations[0].createdBy), String(userId));
  assert.match(observations[0].text, /Compra registrada desde la agenda/);
  assert.match(observations[0].text, /Ibuprofeno 400 mg × 2 \(receta\)/);
  assert.match(observations[0].text, /Protector solar × 3 \(adicional\) · \$24\.50 c\/u/);
  assert.match(observations[0].text, /Total pagado: \$79\.50/);
  assert.match(observations[0].text, /Forma de pago: Tarjeta de débito/);
});

test('guardar sin productos solo limpia datos anteriores y no crea una observación vacía', async () => {
  const { clinicId, userId, patient, appointment } = await seed();

  const result = await H.runController(
    appointments.updateCobroItems,
    H.mockReq(clinicId, userId, {
      items: [],
      itemsValue: null,
      itemsMethod: '',
    }, { role: 'admin', params: { id: String(appointment._id) } }),
  );

  assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
  assert.equal(await PatientObservation.countDocuments({ patient: patient._id }), 0);
  const savedAppointment = await Appointment.findById(appointment._id).lean();
  assert.deepEqual(savedAppointment.prescribedItems, []);
  assert.equal(savedAppointment.itemsValue, null);
});

test('rechaza un producto adicional que no está disponible sin borrar el estado previo', async () => {
  const { clinicId, userId, appointment, product } = await seed();
  await product.updateOne({ active: false });

  const result = await H.runController(
    appointments.updateCobroItems,
    H.mockReq(clinicId, userId, {
      items: [{ source: 'adicional', product: String(product._id), quantity: 1 }],
    }, { role: 'cajero', params: { id: String(appointment._id) } }),
  );

  assert.equal(result.statusCode, 400);
  const savedAppointment = await Appointment.findById(appointment._id).lean();
  assert.equal(savedAppointment.prescribedItems.length, 1);
  assert.equal(savedAppointment.itemsValue, 10);
  assert.equal(await PatientObservation.countDocuments({}), 0);
});

test('registra una compra sin receta y atribuye la recomendación al enfermero, no al cajero', async () => {
  const { clinicId, userId, patient, appointment, product } = await seed();
  const enfermero = await User.create({
    name: 'Enfermero Luis', email: 'enfermero-luis@test.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  const result = await H.runController(
    appointments.updateCobroItems,
    H.mockReq(clinicId, userId, {
      items: [{ source: 'adicional', product: String(product._id), quantity: 1 }],
      itemsValue: 24.5,
      recommendedBy: String(enfermero._id),
    }, { role: 'cajero', params: { id: String(appointment._id) } }),
  );
  assert.equal(result.statusCode, 200, JSON.stringify(result.payload));
  const observation = await PatientObservation.findOne({ patient: patient._id }).lean();
  assert.equal(String(observation.createdBy), String(userId));
  assert.equal(String(observation.recommendedBy), String(enfermero._id));
  assert.equal(observation.recommendedByName, 'Enfermero Luis');
  assert.match(observation.text, /Compra recomendada por: Enfermero Luis/);
  assert.doesNotMatch(observation.text, /\(receta\)/);
});

test('no atribuye una compra de la agenda a personal que no sea doctor o enfermero', async () => {
  const { clinicId, userId, appointment, product } = await seed();
  const result = await H.runController(
    appointments.updateCobroItems,
    H.mockReq(clinicId, userId, {
      items: [{ source: 'adicional', product: String(product._id), quantity: 1 }],
      recommendedBy: String(userId),
    }, { role: 'cajero', params: { id: String(appointment._id) } }),
  );
  assert.equal(result.statusCode, 400);
  assert.equal(await PatientObservation.countDocuments({}), 0);
});

test('el selector de recomendaciones incluye especialidades y enfermería, sin personal de caja', async () => {
  const { clinicId, userId } = await seed();
  const ginecologa = await User.create({
    name: 'Dra. Eva', email: 'dra-eva@test.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'ginecologia' }],
  });
  const enfermera = await User.create({
    name: 'Enf. Rosa', email: 'enf-rosa@test.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  const cajero = await User.create({
    name: 'Caja', email: 'caja-selector@test.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'cajero' }],
  });
  const result = await H.runController(
    users.getPurchaseRecommenders,
    H.mockReq(clinicId, userId, {}, { role: 'cajero' }),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.find((person) => String(person._id) === String(ginecologa._id))?.role, 'ginecologia');
  assert.equal(result.payload.find((person) => String(person._id) === String(enfermera._id))?.role, 'enfermero');
  assert.equal(result.payload.some((person) => String(person._id) === String(cajero._id)), false);
});

test('el selector incluye otras sucursales de la empresa y excluye otra empresa', async () => {
  const { clinicId } = await seed();
  const empresa = await Company.create({ name: 'Empresa clínica', isDefault: true });
  const ajena = await Company.create({ name: 'Otra empresa' });
  await Clinic.create({ _id: clinicId, name: 'Central', company: empresa._id });
  const hermana = await Clinic.create({ name: 'Laboratorio', company: empresa._id });
  const otra = await Clinic.create({ name: 'Externa', company: ajena._id });
  const deLaboratorio = await User.create({
    name: 'Doctora Laboratorio', email: 'laboratorio-recomienda@test.com', password: 'secreto123',
    clinics: [{ clinic: hermana._id, role: 'doctor' }],
  });
  const deOtraEmpresa = await User.create({
    name: 'Doctora Externa', email: 'externa-recomienda@test.com', password: 'secreto123',
    clinics: [{ clinic: otra._id, role: 'doctor' }],
  });
  invalidateCompanyCache();
  const result = await H.runController(
    users.getPurchaseRecommenders,
    H.mockReq(clinicId, deLaboratorio._id, {}, { role: 'cajero' }),
  );
  assert.equal(result.statusCode, 200);
  assert.equal(result.payload.some((person) => String(person._id) === String(deLaboratorio._id)), true);
  assert.equal(result.payload.some((person) => String(person._id) === String(deOtraEmpresa._id)), false);
  invalidateCompanyCache();
});
