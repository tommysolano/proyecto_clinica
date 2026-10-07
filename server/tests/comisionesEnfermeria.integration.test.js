process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

/**
 * Comisiones > Enfermería (oct-2026): el mismo módulo que el de doctores, con los
 * enfermeros contados por sus turnos de enfermería (y el espejo `attendedByNurse`
 * en las citas sin turnos). Tarifas por servicio y por paciente, pagos y detalle.
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Appointment = require('../models/Appointment');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const CommissionRule = require('../models/CommissionRule');
const CommissionPayout = require('../models/CommissionPayout');
const ctrl = require('../controllers/commissionController');

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

const reqDe = (clinicId, extra = {}) => ({
  clinicId,
  user: { _id: new mongoose.Types.ObjectId(), isSuperAdmin: true },
  query: {},
  body: {},
  params: {},
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

const dia = (m, d) => new Date(2026, m - 1, d, 12, 0, 0, 0);
const MES = { start: '2026-08-01', end: '2026-08-31' };

test('enfermería: cuenta a cada enfermero por sus turnos y le paga con sus tarifas', async () => {
  const clinic = await Clinic.create({ name: 'ENF', nombreComercial: 'ENF', active: true });
  const ana = await User.create({
    name: 'Ana Enfermera', email: 'ana.enf@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'enfermero' }],
  });
  const beto = await User.create({
    name: 'Beto Enfermero', email: 'beto.enf@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'enfermero' }],
  });
  const doctor = await User.create({
    name: 'Doc Turno', email: 'doc.enf@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'doctor' }],
  });
  const p1 = await Patient.create({ clinic: clinic._id, firstName: 'Uno', lastName: 'Suero' });
  const p2 = await Patient.create({ clinic: clinic._id, firstName: 'Dos', lastName: 'Detox' });
  const suero = await AppointmentServiceItem.create({ clinic: clinic._id, name: 'Sueroterapia', slug: 'sueroterapia' });
  const consulta = await AppointmentServiceItem.create({ clinic: clinic._id, name: 'Consulta', slug: 'consulta' });

  await Appointment.create([
    // Doctor y después Ana con el suero.
    {
      clinic: clinic._id, patient: p1._id, doctor: doctor._id, attendedByNurse: ana._id,
      date: dia(8, 3), startTime: '09:00', status: 'completada',
      serviceItem: suero._id, serviceName: 'Sueroterapia', agreedValue: 50,
      turns: [
        { kind: 'doctor', user: doctor._id, status: 'completado', order: 0 },
        { kind: 'enfermeria', user: ana._id, status: 'completado', order: 1, serviceName: 'Suero' },
      ],
    },
    // Detox de dos enfermeros en secuencia: cuentan los dos.
    {
      clinic: clinic._id, patient: p2._id, attendedByNurse: beto._id,
      date: dia(8, 4), startTime: '10:00', status: 'completada',
      serviceItem: suero._id, serviceName: 'Sueroterapia', agreedValue: 40,
      turns: [
        { kind: 'enfermeria', user: ana._id, status: 'completado', order: 0, serviceName: 'Canalización' },
        { kind: 'enfermeria', user: beto._id, status: 'completado', order: 1, serviceName: 'Detox' },
      ],
    },
    // Cita vieja sin turnos: manda el espejo.
    {
      clinic: clinic._id, patient: p2._id, attendedByNurse: beto._id,
      date: dia(8, 5), startTime: '11:00', status: 'completada',
      serviceItem: consulta._id, serviceName: 'Consulta', agreedValue: 20,
    },
    // El turno de Ana se OMITIÓ: no es suya.
    {
      clinic: clinic._id, patient: p1._id, attendedByNurse: beto._id,
      date: dia(8, 6), startTime: '12:00', status: 'completada',
      serviceItem: suero._id, serviceName: 'Sueroterapia', agreedValue: 30,
      turns: [
        { kind: 'enfermeria', user: ana._id, status: 'omitido', order: 0 },
        { kind: 'enfermeria', user: beto._id, status: 'completado', order: 1 },
      ],
    },
  ]);

  // Ana: $5 por cada sueroterapia. Beto: 10 % por paciente atendido.
  const r1 = await llamar(ctrl.saveDoctorServiceRule, reqDe(clinic._id, {
    body: { doctor: String(ana._id), service: String(suero._id), clinics: [String(clinic._id)], amountType: 'fixed', value: 5 },
  }));
  assert.strictEqual(r1.code, 200);
  const r2 = await llamar(ctrl.saveDoctorPatientRule, reqDe(clinic._id, {
    body: { doctor: String(beto._id), clinics: [String(clinic._id)], amountType: 'percent', value: 10 },
  }));
  assert.strictEqual(r2.code, 200);

  // Filtro: solo enfermeros.
  const opciones = await llamar(ctrl.doctorOptions, reqDe(clinic._id, { query: { clinic: 'all', area: 'enfermeria' } }));
  const nombres = opciones.payload.map((u) => u.name).sort();
  assert.deepStrictEqual(nombres, ['Ana Enfermera', 'Beto Enfermero']);
  assert.strictEqual(opciones.payload[0].roleInClinic, 'enfermero');

  const resumen = await llamar(ctrl.doctorSummary, reqDe(clinic._id, { query: { ...MES, area: 'enfermeria' } }));
  assert.strictEqual(resumen.code, 200);
  assert.strictEqual(resumen.payload.area, 'enfermeria');
  const filaAna = resumen.payload.doctors.find((d) => d.doctorId === String(ana._id));
  const filaBeto = resumen.payload.doctors.find((d) => d.doctorId === String(beto._id));
  assert.ok(!resumen.payload.doctors.some((d) => d.doctorId === String(doctor._id)), 'el doctor no sale en enfermería');

  assert.strictEqual(filaAna.total, 2, 'Ana: su suero y la canalización del detox (no la omitida)');
  assert.strictEqual(filaAna.patients, 2);
  assert.strictEqual(filaAna.commissionTotal, 10);
  assert.strictEqual(filaAna.services.find((s) => s.serviceId === String(suero._id)).commission.earned, 10);

  assert.strictEqual(filaBeto.total, 3);
  assert.strictEqual(filaBeto.patients, 2, 'tres citas, dos pacientes');
  assert.strictEqual(filaBeto.commissionTotal, 9, '10 % de 40 + 20 + 30');
  assert.strictEqual(filaBeto.patientCommission.earned, 9);
  assert.strictEqual(filaBeto.referrals.indicadas, 0);

  // Doctores no cambia: el doctor sigue con su cita y los enfermeros no aparecen.
  const docs = await llamar(ctrl.doctorSummary, reqDe(clinic._id, { query: MES }));
  assert.deepStrictEqual(docs.payload.doctors.map((d) => d.doctorId), [String(doctor._id)]);

  // La contabilización (computeCommissions) dice lo mismo: 10 + 9.
  const reporte = await llamar(ctrl.report, reqDe(clinic._id, { query: MES }));
  assert.strictEqual(reporte.payload.total, 19);

  // Detalle de citas de Ana.
  const detalle = await llamar(ctrl.doctorAppointments, reqDe(clinic._id, {
    query: { ...MES, area: 'enfermeria', doctor: String(ana._id) },
  }));
  assert.strictEqual(detalle.payload.totals.appointments, 2);
  assert.strictEqual(detalle.payload.doctorNames[String(ana._id)], 'Ana Enfermera');
  assert.ok(detalle.payload.appointments.every((a) => a.doctorId === String(ana._id)));

  // Pago del período de Ana: lo pendiente, y después queda pagado.
  const pago = await llamar(ctrl.createPayouts, reqDe(clinic._id, {
    body: { ...MES, clinic: 'all', doctors: [String(ana._id)], area: 'enfermeria' },
  }));
  assert.strictEqual(pago.code, 201);
  assert.strictEqual(pago.payload.created[0].amount, 10);
  assert.strictEqual(await CommissionPayout.countDocuments({ doctor: ana._id }), 1);

  const despues = await llamar(ctrl.doctorSummary, reqDe(clinic._id, { query: { ...MES, area: 'enfermeria' } }));
  const anaDespues = despues.payload.doctors.find((d) => d.doctorId === String(ana._id));
  assert.strictEqual(anaDespues.paidTotal, 10);
  assert.strictEqual(anaDespues.pendingTotal, 0);
});
