const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const PatientObservation = require('../models/PatientObservation');
const appointments = require('../controllers/appointmentController');

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
