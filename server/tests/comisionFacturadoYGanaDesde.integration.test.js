process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

/**
 * COMISIONES DE DOCTORES (nov-2026):
 *  - El VALOR de la cita es lo FACTURADO (venta enlazada) cuando existe: desde la facturación
 *    electrónica ya no se escribe `agreedValue` y el «generado» se quedaba en el 29-10.
 *  - «GANA DESDE»: atendido antes de esa hora, la comisión por paciente/servicio paga $0.
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Appointment = require('../models/Appointment');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const Sale = require('../models/Sale');
const CommissionRule = require('../models/CommissionRule');
const ctrl = require('../controllers/commissionController');
const { facturadoPorCita } = require('../utils/valorFacturado');

let mongod;
test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  await CommissionRule.syncIndexes();
});
test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});
test.beforeEach(async () => {
  for (const c of Object.values(mongoose.connection.collections)) await c.deleteMany({});
});

const reqDe = (clinicId, extra = {}) => ({
  clinicId,
  user: { _id: new mongoose.Types.ObjectId(), isSuperAdmin: true },
  query: {}, body: {}, params: {},
  ...extra,
});
const llamar = async (fn, req) => {
  let payload = null;
  let code = 200;
  const res = {
    json: (p) => { payload = p; },
    status: (s) => { code = s; return { json: (p) => { payload = p; } }; },
  };
  await fn(req, res);
  return { payload, code };
};
// Fecha a una hora de Ecuador (UTC-5).
const ec = (d, hhmm) => new Date(`2026-11-${String(d).padStart(2, '0')}T${hhmm}:00-05:00`);

async function escenario() {
  const sede = await Clinic.create({ name: 'Extensión', nombreComercial: 'Extensión', active: true });
  const doctor = await User.create({
    name: 'Dra. Prueba', email: `dra${Date.now()}@test.com`, password: '123456',
    clinics: [{ clinic: sede._id, role: 'doctor' }],
  });
  const paciente = await Patient.create({ clinic: sede._id, firstName: 'Ana', lastName: 'P' });
  const cita = (extra) => Appointment.create({
    clinic: sede._id, patient: paciente._id, doctor: doctor._id, date: ec(3, '12:00'),
    status: 'completada', serviceName: 'CONSULTA', ...extra,
  });
  const vender = (apt, lineas, total) => Sale.create({
    clinic: sede._id, saleNumber: `V-${Math.random().toString(36).slice(2, 8)}`, appointment: apt._id,
    items: lineas.map(([category, lineTotal]) => ({ product: new mongoose.Types.ObjectId(), productName: category, category, quantity: 1, unitPrice: lineTotal, lineTotal, subtotal: lineTotal })),
    subtotal: total, taxAmount: 0, total, paymentMethod: 'efectivo', status: 'completada',
  });
  return { sede, doctor, cita, vender };
}

test('el valor generado usa lo facturado (servicios) y, sin ventas, lo escrito', async () => {
  const { sede, doctor, cita, vender } = await escenario();
  // Antigua: valor escrito, sin venta.
  await cita({ startTime: '09:00', agreedValue: 30 });
  // Nueva: sin valor escrito, facturada con un servicio de $40 y un producto de $15.
  const nueva = await cita({ startTime: '10:00' });
  await vender(nueva, [['servicio', 40], ['insumo', 15]], 55);
  // Una venta anulada no cuenta.
  const anulada = await cita({ startTime: '11:00' });
  const v = await vender(anulada, [['servicio', 99]], 99);
  await Sale.updateOne({ _id: v._id }, { $set: { status: 'anulada' } });

  const mapa = await facturadoPorCita([nueva._id, anulada._id]);
  assert.deepStrictEqual(mapa.get(String(nueva._id)), { servicios: 40, productos: 15, total: 55, ventas: 1 });
  assert.strictEqual(mapa.has(String(anulada._id)), false);

  const r = await llamar(ctrl.doctorSummary, reqDe(sede._id, { query: { start: '2026-11-01', end: '2026-11-30', clinic: 'all' } }));
  const fila = r.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila.generated, 70, '30 escritos + 40 facturados de servicio (el producto va aparte)');

  // Una comisión del 10 % se calcula sobre lo facturado.
  await llamar(ctrl.saveDoctorPatientRule, reqDe(sede._id, { body: { doctor: String(doctor._id), clinics: [String(sede._id)], amountType: 'percent', value: 10 } }));
  const r2 = await llamar(ctrl.doctorSummary, reqDe(sede._id, { query: { start: '2026-11-01', end: '2026-11-30', clinic: 'all' } }));
  const f2 = r2.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(f2.patientCommission.earned, 7, '10 % de 30 + 10 % de 40');

  // El detalle de citas dice «facturado».
  const det = await llamar(ctrl.doctorAppointments, reqDe(sede._id, { query: { start: '2026-11-01', end: '2026-11-30', clinic: 'all', doctor: String(doctor._id) } }));
  const filaNueva = det.payload.appointments.find((a) => a._id === String(nueva._id) || a.id === String(nueva._id));
  assert.strictEqual(filaNueva.payment.invoicedValue, 40);
  assert.strictEqual(det.payload.totals.payments, 70);
});

test('«gana desde»: antes de esa hora no paga; cuenta la hora en que atendió el doctor', async () => {
  const { sede, doctor, cita } = await escenario();
  const g = await llamar(ctrl.saveDoctorPatientRule, reqDe(sede._id, {
    body: { doctor: String(doctor._id), clinics: [String(sede._id)], amountType: 'fixed', value: 5, minStartTime: '12:30' },
  }));
  assert.strictEqual(g.code, 200, JSON.stringify(g.payload));
  assert.strictEqual(g.payload.minStartTime, '12:30');

  // Agendada a las 12:00 pero el doctor la atendió a las 12:45 → paga.
  await cita({ startTime: '12:00', agreedValue: 20, turns: [{ user: doctor._id, kind: 'doctor', status: 'completado', startedAt: ec(3, '12:45'), completedAt: ec(3, '13:00') }] });
  // Atendida a las 11:10 → no paga.
  await cita({ startTime: '11:00', agreedValue: 20, turns: [{ user: doctor._id, kind: 'doctor', status: 'completado', startedAt: ec(3, '11:10'), completedAt: ec(3, '11:30') }] });
  // Sin turnos con hora: cuenta la hora de la cita (14:00 → paga).
  await cita({ startTime: '14:00', agreedValue: 20 });

  const r = await llamar(ctrl.doctorSummary, reqDe(sede._id, { query: { start: '2026-11-01', end: '2026-11-30', clinic: 'all' } }));
  const fila = r.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila.patientCommission.earned, 10, 'dos de tres citas pagan $5');
  assert.strictEqual(fila.patientCommission.beforeTime, 1);
  assert.strictEqual(fila.patientCommission.minStartTime, '12:30');

  // Hora inválida → 400.
  const mala = await llamar(ctrl.saveDoctorPatientRule, reqDe(sede._id, {
    body: { doctor: String(doctor._id), clinics: [String(sede._id)], amountType: 'fixed', value: 5, minStartTime: '25:99' },
  }));
  assert.strictEqual(mala.code, 400);
});
