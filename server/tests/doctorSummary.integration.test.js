process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const Appointment = require('../models/Appointment');
const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const User = require('../models/User');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const ClinicalRecord = require('../models/ClinicalRecord');
const Sale = require('../models/Sale');
const Referral = require('../models/Referral');
const ctrl = require('../controllers/commissionController');

let mongod;

test.before(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

test.after(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const construir = async () => {
  const clinicA = await Clinic.create({ name: 'Central', nombreComercial: 'Central', active: true });
  const clinicB = await Clinic.create({ name: 'Extension', nombreComercial: 'Extensión', active: true });
  const doctor = await User.create({
    name: 'Jorge Perez', email: 'jorge@test.com', password: '123456',
    clinics: [{ clinic: clinicA._id, role: 'doctor' }], specialty: 'General',
  });
  const otro = await User.create({
    name: 'Ana Lopez', email: 'ana@test.com', password: '123456',
    clinics: [{ clinic: clinicA._id, role: 'optica' }],
  });
  const paciente = await Patient.create({ clinic: clinicA._id, firstName: 'Luis', lastName: 'Rojas' });
  const consulta = await AppointmentServiceItem.create({ clinic: clinicA._id, name: 'Consulta', slug: 'consulta' });
  const detox = await AppointmentServiceItem.create({ clinic: clinicA._id, name: 'Detox', slug: 'detox' });

  const dia = (d) => new Date(2026, 7, d, 12, 0, 0, 0);
  await Appointment.create([
    { clinic: clinicA._id, patient: paciente._id, doctor: doctor._id, date: dia(5), startTime: '09:00', status: 'asistida', serviceName: 'Consulta' },
    { clinic: clinicA._id, patient: paciente._id, doctor: doctor._id, date: dia(6), startTime: '09:00', status: 'completada', serviceName: 'Detox' },
    { clinic: clinicB._id, patient: paciente._id, doctor: doctor._id, date: dia(7), startTime: '09:00', status: 'asistida', serviceName: 'Detox' },
    { clinic: clinicA._id, patient: paciente._id, doctor: otro._id, date: dia(8), startTime: '09:00', status: 'cancelada', serviceName: 'Consulta' },
  ]);
  return { clinicA, clinicB, doctor, otro, consulta, detox };
};

const reqDe = (clinicId) => ({
  clinicId,
  user: { isSuperAdmin: true },
  query: {},
});

const respDe = () => {
  let payload = null;
  let status = 200;
  return {
    json: (p) => { payload = p; },
    status: (s) => { status = s; return { json: (p) => { payload = p; } }; },
    get payload() { return payload; },
    get status() { return status; },
  };
};

test('resume las citas por doctor con estados y servicios', async () => {
  const { clinicA, doctor, otro, consulta, detox } = await construir();
  const req = reqDe(clinicA._id);
  req.query = { start: '2026-08-01', end: '2026-08-31' };
  const res = respDe();
  await ctrl.doctorSummary(req, res);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.payload.totals.total, 2);
  const fila = res.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.ok(fila);
  assert.strictEqual(fila.total, 2);
  assert.strictEqual(fila.byStatus.asistida, 1);
  assert.strictEqual(fila.byStatus.completada, 1);
  const nombres = fila.services.map((s) => s.name).sort();
  assert.deepStrictEqual(nombres, ['Consulta', 'Detox']);
  assert.strictEqual(
    fila.services.find((s) => s.name === 'Consulta').serviceId,
    String(consulta._id),
    'las citas antiguas por nombre se vinculan al catálogo para configurar su comisión'
  );
  assert.strictEqual(fila.clinics[0], 'Central');
  // el doctor de la otra especialidad no aparece porque su única cita es 'cancelada'
  // (fuera del filtro por defecto asistida+completada)
  assert.ok(!res.payload.doctors.some((d) => d.doctorId === String(otro._id)));

  // filtro por UN servicio: solo la cita de Detox
  const req2 = reqDe(clinicA._id);
  req2.query = { start: '2026-08-01', end: '2026-08-31', service: String(detox._id), status: 'asistida,completada' };
  const res2 = respDe();
  await ctrl.doctorSummary(req2, res2);
  assert.strictEqual(res2.payload.totals.total, 1);
  const fila2 = res2.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila2.byStatus.completada, 1);
  assert.strictEqual(fila2.byStatus.asistida, 0);
  assert.deepStrictEqual(fila2.services.map((s) => s.name), ['Detox']);

  // cita de la OTRA sucursal (no entra por defecto: sin 'clinic=all' es solo la activa)
  const req4 = reqDe(clinicA._id);
  req4.query = { start: '2026-08-01', end: '2026-08-31', clinic: 'all' };
  const res4 = respDe();
  await ctrl.doctorSummary(req4, res4);
  assert.strictEqual(res4.payload.totals.total, 3);
  const fila4 = res4.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila4.total, 3);
  assert.ok(fila4.clinics.includes('Central'));
  assert.ok(fila4.clinics.includes('Extensión'));

  // cita sin estado: la del servicio Consulta
  const req3 = reqDe(clinicA._id);
  req3.query = { start: '2026-08-01', end: '2026-08-31', service: String(consulta._id), status: 'asistida,completada,cancelada' };
  const res3 = respDe();
  await ctrl.doctorSummary(req3, res3);
  assert.strictEqual(res3.payload.totals.total, 2);
  const fila3 = res3.payload.doctors.find((d) => d.doctorId === String(otro._id));
  assert.strictEqual(fila3.byStatus.cancelada, 1);
});

test('detalle de citas: pago, canje, seguimiento con suero, multiprofesional y derivaciones', async () => {
  const clinic = await Clinic.create({ name: 'Sur', nombreComercial: 'Sur', active: true });
  const doctor = await User.create({
    name: 'Marcos Vera', email: 'marcos@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'doctor' }],
  });
  const colega = await User.create({
    name: 'Bea Diaz', email: 'bea@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'doctor' }],
  });
  const paciente = await Patient.create({ clinic: clinic._id, firstName: 'Pedro', lastName: 'Sáenz' });

  // Seguimiento con receta: un suero y otro medicamento.
  const rec = await ClinicalRecord.create({
    clinic: clinic._id,
    patient: paciente._id,
    followUps: [{
      motivoConsulta: 'Detox',
      recetaItems: [
        { name: 'Suero Detox', isSerum: true, quantity: 7 },
        { name: 'Paracetamol', quantity: 1 },
      ],
    }],
  });
  const seguimiento = rec.followUps[0];

  const dia = (d) => new Date(2026, 7, d, 12, 0, 0, 0);
  // Dos citas del MISMO paciente con este doctor (visita 1 y 2).
  const cita1 = await Appointment.create({
    clinic: clinic._id, patient: paciente._id, doctor: doctor._id,
    date: dia(10), startTime: '09:00', status: 'completada',
    serviceName: 'Detox', agreedValue: 40, advancePayment: 'abono', advanceAmount: 20, advanceMethod: 'efectivo',
    turns: [
      { kind: 'doctor', user: doctor._id, status: 'completado', followUp: seguimiento._id },
      // un segundo doctor en la MISMA cita: multiprofesional
      { kind: 'doctor', user: colega._id, status: 'completado' },
    ],
  });
  const cita2 = await Appointment.create({
    clinic: clinic._id, patient: paciente._id, doctor: doctor._id,
    date: dia(20), startTime: '10:00', status: 'asistida',
    serviceName: 'Consulta', isCanje: true,
  });
  await Sale.create({
    clinic: clinic._id, appointment: cita1._id, patient: paciente._id,
    items: [{ product: new mongoose.Types.ObjectId(), productName: 'Detox', quantity: 1, unitPrice: 40, subtotal: 40 }],
    subtotal: 40, taxAmount: 0, total: 40,
  });
  await Referral.create({
    clinic: clinic._id, patient: paciente._id, fromDoctor: doctor._id,
    toDoctor: colega._id, specialty: 'Cardiología', reason: 'Dolor torácico',
    status: 'agendada', date: dia(15),
  });

  const req = reqDe(clinic._id);
  req.query = { start: '2026-08-01', end: '2026-08-31', doctor: String(doctor._id) };
  const res = respDe();
  await ctrl.doctorAppointments(req, res);

  assert.strictEqual(res.status, 200);
  const citas = res.payload.appointments;
  assert.strictEqual(citas.length, 2);

  // Visitas del mismo paciente: 1 y 2
  const porFecha = citas.sort((a, b) => new Date(a.date) - new Date(b.date));
  assert.strictEqual(porFecha[0].visitNumber, 1);
  assert.strictEqual(porFecha[0].visitsTotal, 2);
  assert.strictEqual(porFecha[1].visitNumber, 2);
  assert.strictEqual(porFecha[1].visitsTotal, 2);

  // Multiprofesional: la cita 1 tiene DOS doctores en turnos
  assert.strictEqual(porFecha[0].multiprofesional, true);
  assert.strictEqual(porFecha[1].multiprofesional, false);
  assert.strictEqual(porFecha[0].atendientes.length, 2);

  // Seguimiento: suero recetado + otro medicamento
  const parte = porFecha[0].seguimientos[0];
  assert.ok(parte);
  assert.strictEqual(parte.sueros, 1);
  assert.deepStrictEqual(parte.otros, ['Paracetamol']);

  // Pago de la cita 1: valor $40 con abono de $20 en efectivo, y su venta ligada
  assert.strictEqual(porFecha[0].payment.agreedValue, 40);
  assert.strictEqual(porFecha[0].payment.advancePayment, 'abono');
  assert.strictEqual(porFecha[0].payment.advanceAmount, 20);
  assert.strictEqual(porFecha[0].payment.totalValue, 40);
  assert.ok(porFecha[0].venta);
  assert.strictEqual(porFecha[0].venta.total, 40);
  assert.ok(porFecha[0].venta.number);

  // Cita 2: canje, sin venta
  assert.strictEqual(porFecha[1].payment.isCanje, true);
  assert.strictEqual(porFecha[1].payment.totalValue, 0);
  assert.strictEqual(porFecha[1].venta, null);
  assert.strictEqual(res.payload.totals.payments, 40, 'el abono no se suma otra vez al valor acordado y el canje vale cero');

  // Derivaciones añadidas por el doctor
  const derivas = res.payload.referralsByDoctor[String(doctor._id)];
  assert.strictEqual(derivas.length, 1);
  assert.strictEqual(derivas[0].specialty, 'Cardiología');
  assert.strictEqual(derivas[0].status, 'agendada');
  assert.strictEqual(derivas[0].patient, 'PEDRO SÁENZ');
});

test('prioriza la comisión por servicio sobre la comisión base por paciente', async () => {
  const clinic = await Clinic.create({ name: 'Comisiones', nombreComercial: 'Comisiones', active: true });
  const doctor = await User.create({
    name: 'Domenica Prueba', email: 'domenica-comision@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'doctor' }],
  });
  const paciente = await Patient.create({ clinic: clinic._id, firstName: 'Paciente', lastName: 'Comision' });
  const servicio = await AppointmentServiceItem.create({
    clinic: clinic._id, name: 'Mujer Sana 360', slug: 'mujer sana 360',
  });
  const servicioSinComision = await AppointmentServiceItem.create({
    clinic: clinic._id, name: 'Control sin comisión', slug: 'control sin comision',
  });
  await Appointment.create([
    {
      clinic: clinic._id, patient: paciente._id, doctor: doctor._id,
      date: new Date(2026, 7, 12, 12, 0, 0), startTime: '09:00', status: 'completada',
      serviceItem: servicio._id, serviceName: servicio.name, agreedValue: 80,
    },
    {
      clinic: clinic._id, patient: paciente._id, doctor: doctor._id,
      date: new Date(2026, 7, 13, 12, 0, 0), startTime: '10:00', status: 'completada',
      serviceItem: servicioSinComision._id, serviceName: servicioSinComision.name, agreedValue: 30,
    },
  ]);

  const saveReq = reqDe(clinic._id);
  saveReq.body = {
    doctor: String(doctor._id), service: String(servicio._id),
    clinics: [String(clinic._id)], amountType: 'fixed', value: 15,
  };
  const saveRes = respDe();
  await ctrl.saveDoctorServiceRule(saveReq, saveRes);
  assert.strictEqual(saveRes.status, 200);

  const summaryReq = reqDe(clinic._id);
  summaryReq.query = { start: '2026-08-01', end: '2026-08-31' };
  const summaryRes = respDe();
  await ctrl.doctorSummary(summaryReq, summaryRes);
  const row = summaryRes.payload.doctors[0].services.find((s) => s.serviceId === String(servicio._id));
  assert.deepStrictEqual(
    { amountType: row.commission.amountType, value: row.commission.value, earned: row.commission.earned },
    { amountType: 'fixed', value: 15, earned: 15 }
  );
  assert.strictEqual(summaryRes.payload.doctors[0].commissionTotal, 15);

  const reportReq = reqDe(clinic._id);
  reportReq.query = { start: '2026-08-01', end: '2026-08-31' };
  const reportFixed = respDe();
  await ctrl.report(reportReq, reportFixed);
  assert.strictEqual(reportFixed.payload.total, 15);

  // Base de $5 por paciente. En Mujer Sana NO se suma: gana $15 por servicio.
  // En el control, que no tiene comisión propia, sí gana los $5 base.
  const patientReq = reqDe(clinic._id);
  patientReq.body = {
    doctor: String(doctor._id), clinics: [String(clinic._id)], amountType: 'fixed', value: 5,
  };
  const patientRes = respDe();
  await ctrl.saveDoctorPatientRule(patientReq, patientRes);
  assert.strictEqual(patientRes.status, 200);

  const reportWithBase = respDe();
  await ctrl.report(reportReq, reportWithBase);
  assert.strictEqual(reportWithBase.payload.total, 20, 'servicio $15 + base $5; no $25');
  assert.deepStrictEqual(
    reportWithBase.payload.detail.map((d) => d.source).sort(),
    ['cita atendida', 'paciente atendido']
  );

  const summaryWithBase = respDe();
  await ctrl.doctorSummary(summaryReq, summaryWithBase);
  const doctorSummary = summaryWithBase.payload.doctors[0];
  assert.strictEqual(doctorSummary.patientCommission.earned, 5);
  assert.strictEqual(doctorSummary.commissionTotal, 20);

  saveReq.body.amountType = 'percent';
  saveReq.body.value = 25;
  const updateRes = respDe();
  await ctrl.saveDoctorServiceRule(saveReq, updateRes);
  assert.strictEqual(updateRes.status, 200);

  const reportPercent = respDe();
  await ctrl.report(reportReq, reportPercent);
  assert.strictEqual(reportPercent.payload.total, 25, '25% de $80 por servicio + $5 base de la otra cita');
});

test('resumen de call center: citas agendadas por agente, nuevos vs recurrentes', async () => {
  const clinic = await Clinic.create({ name: 'Norte', nombreComercial: 'Norte', active: true });
  const agente = await User.create({
    name: 'Carla Call', email: 'carla@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'call_center' }],
  });
  const admin = await User.create({
    name: 'El Admin', email: 'admincc@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'admin' }],
  });
  const paciente = await Patient.create({ clinic: clinic._id, firstName: 'Nueva', lastName: 'Uno' });
  const paciente2 = await Patient.create({ clinic: clinic._id, firstName: 'Vieja', lastName: 'Dos' });

  const dia = (d) => new Date(2026, 7, d, 12, 0, 0, 0);
  await Appointment.create([
    { clinic: clinic._id, patient: paciente._id, date: dia(3), startTime: '09:00', status: 'pendiente', createdBy: agente._id, isFirstVisit: true },
    { clinic: clinic._id, patient: paciente2._id, date: dia(4), startTime: '09:00', status: 'asistida', createdBy: agente._id, isFirstVisit: false },
    { clinic: clinic._id, patient: paciente2._id, date: dia(5), startTime: '09:00', status: 'completada', createdBy: admin._id, isFirstVisit: false },
  ]);

  const req = reqDe(clinic._id);
  req.query = { start: '2026-08-01', end: '2026-08-31' };
  const res = respDe();
  await ctrl.callCenterSummary(req, res);

  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.payload.totals.total, 2);
  const fila = res.payload.agents.find((a) => a.userId === String(agente._id));
  assert.ok(fila);
  assert.strictEqual(fila.total, 2);
  assert.strictEqual(fila.nuevos, 1);
  assert.strictEqual(fila.recurrentes, 1);
  assert.strictEqual(fila.clinics[0], 'Norte');
  // el admin NO es agente de call center: sus citas no cuentan aquí
  assert.ok(!res.payload.agents.some((a) => a.name === 'El Admin' && a.total > 0));
});
