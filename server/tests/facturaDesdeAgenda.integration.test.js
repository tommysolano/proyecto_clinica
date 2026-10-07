/**
 * FACTURA DESDE LA AGENDA (oct-2026, en prueba): el super admin enciende
 * `User.canBill` a quien quiera; esa persona cobra la cita con una VENTA de
 * verdad (enlazada a la cita, con su contabilidad) y la agenda sabe qué citas
 * ya están cobradas. Sin el permiso, no se puede enlazar una venta a una cita.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const Sale = require('../models/Sale');
const JournalEntry = require('../models/JournalEntry');
const sales = require('../controllers/saleController');
const appt = require('../controllers/appointmentController');
const users = require('../controllers/userController');
const patients = require('../controllers/patientController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId } = await H.seedClinic();
  const cajero = await User.create({
    name: 'Carla', email: 'carla@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'cajero' }],
  });
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405', email: 'ana@t.com', phone: '0991112233',
  });
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente', reason: 'Control',
  });
  const servicio = await H.makeProduct(clinicId, {
    name: 'Consulta general', category: 'servicio', unlimited: true, salePrice: 30,
  });
  return { clinicId, cajero, patient, cita, servicio };
}

const comoCajero = (clinicId, cajero, body = {}, extra = {}) => {
  const req = H.mockReq(clinicId, cajero._id, body, { role: 'cajero', ...extra });
  req.user = { ...cajero.toObject(), _id: cajero._id };
  return req;
};

const ventaDeCita = (clinicId, cajero, patient, cita, servicio, extra = {}) => H.runController(
  sales.createSale,
  comoCajero(clinicId, cajero, {
    date: H.docDate(),
    patient: String(patient._id),
    appointment: String(cita._id),
    clientName: 'Ana Pérez',
    clientCedula: '0102030405',
    items: [{ product: String(servicio._id), quantity: 1, unitPrice: 30 }],
    ...extra,
  })
);

test('sin el permiso, no se puede cobrar una cita; con él, la venta queda enlazada y contabilizada', async () => {
  const { clinicId, cajero, patient, cita, servicio } = await seed();

  const sin = await ventaDeCita(clinicId, cajero, patient, cita, servicio, { paymentMethod: 'efectivo' });
  assert.equal(sin.statusCode, 403);
  assert.equal(sin.payload.code, 'BILLING_DISABLED');
  assert.equal(await Sale.countDocuments({}), 0);

  // El super admin lo enciende.
  const r = await H.runController(users.setBillingPermission, H.mockReq(clinicId, cajero._id, { canBill: true }, {
    role: 'admin', params: { id: String(cajero._id) },
  }));
  assert.equal(r.payload.canBill, true);
  const conPermiso = await User.findById(cajero._id);

  // Pago DIVIDIDO: mitad efectivo, mitad a crédito.
  const v = await ventaDeCita(clinicId, conPermiso, patient, cita, servicio, {
    paymentMethod: 'mixto',
    payments: [{ method: 'efectivo', amount: 15 }, { method: 'credito', amount: 15 }],
    creditDays: 30,
  });
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  const venta = await Sale.findById(v.payload._id).lean();
  assert.equal(String(venta.appointment), String(cita._id));
  assert.equal(String(venta.patient), String(patient._id));
  assert.equal(venta.payments.length, 2);
  assert.ok(venta.journalEntry, 'la venta tiene su asiento contable');
  const asiento = await JournalEntry.findById(venta.journalEntry).lean();
  assert.ok(asiento, 'el asiento existe');
});

test('la agenda dice qué citas ya están cobradas (solo a quien cobra)', async () => {
  const { clinicId, cajero, patient, cita, servicio } = await seed();
  await User.updateOne({ _id: cajero._id }, { $set: { canBill: true } });
  const conPermiso = await User.findById(cajero._id);
  const v = await ventaDeCita(clinicId, conPermiso, patient, cita, servicio, { paymentMethod: 'efectivo' });
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));

  const lista = await H.runController(appt.getAppointments, comoCajero(clinicId, conPermiso, {}, { query: {} }));
  const fila = lista.payload.find((a) => String(a._id) === String(cita._id));
  assert.ok(fila.cobro, 'la cita trae su cobro');
  assert.equal(fila.cobro.total, Number(venta(v).total));
  assert.equal(fila.cobro.ventas.length, 1);

  // A un doctor no se le manda.
  const doctor = await User.create({ name: 'Doc', email: 'doc@t.com', password: 'secreto123', clinics: [{ clinic: clinicId, role: 'doctor' }] });
  const reqDoc = H.mockReq(clinicId, doctor._id, {}, { role: 'doctor', query: {} });
  reqDoc.user = { ...doctor.toObject(), _id: doctor._id };
  const deDoctor = await H.runController(appt.getAppointments, reqDoc);
  assert.ok((deDoctor.payload || []).every((a) => !a.cobro));
});

function venta(r) { return r.payload; }

test('el super admin ve el personal de caja; la ficha da los datos de facturación sin el resto', async () => {
  const { clinicId, cajero, patient } = await seed();
  const lista = await H.runController(users.getBillingStaff, H.mockReq(clinicId, cajero._id, {}, { role: 'admin' }));
  assert.equal(lista.statusCode, 200);
  assert.ok(lista.payload.some((u) => u.name === 'Carla' && u.canBill === false));

  const req = comoCajero(clinicId, cajero, {}, { params: { id: String(patient._id) }, query: { withContact: '1' } });
  const ficha = await H.runController(patients.getPatient, req);
  assert.equal(ficha.statusCode, 200);
  assert.equal(ficha.payload.cedula, '0102030405');
  assert.equal(ficha.payload.email, 'ana@t.com');
  assert.deepEqual(
    Object.keys(ficha.payload).sort(),
    ['_id', 'address', 'cedula', 'email', 'firstName', 'lastName', 'phone'].sort()
  );
});
