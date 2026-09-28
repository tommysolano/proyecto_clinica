process.env.JWT_SECRET = 'test-secret';
process.env.NODE_ENV = 'test';

/**
 * Comisiones > Doctores (sep-2026): tarifas de «solo la primera vez», comisión
 * por DERIVACIÓN realizada, pagos por período y el filtro de doctores con rol.
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
const ClinicalRecord = require('../models/ClinicalRecord');
const Referral = require('../models/Referral');
const CommissionRule = require('../models/CommissionRule');
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

const respDe = () => {
  let payload = null;
  let status = 200;
  return {
    json: (p) => { payload = p; },
    status: (s) => { status = s; return { json: (p) => { payload = p; } }; },
    get payload() { return payload; },
    get code() { return status; },
  };
};

const llamar = async (fn, req) => {
  const res = respDe();
  await fn(req, res);
  return res;
};

const dia = (m, d) => new Date(2026, m - 1, d, 12, 0, 0, 0);

test('«solo la primera vez»: el servicio repetido no paga, aunque sea en otra sucursal', async () => {
  const clinic = await Clinic.create({ name: 'PV', nombreComercial: 'PV', active: true });
  const otra = await Clinic.create({ name: 'PV2', nombreComercial: 'PV2', active: true });
  const doctor = await User.create({
    name: 'Primera Vez', email: 'pv@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'doctor' }],
  });
  const paciente = await Patient.create({ clinic: clinic._id, firstName: 'Repite', lastName: 'Tratamiento' });
  const nuevo = await Patient.create({ clinic: clinic._id, firstName: 'Estrena', lastName: 'Tratamiento' });
  const hifu = await AppointmentServiceItem.create({ clinic: clinic._id, name: 'HIFU', slug: 'hifu' });

  await Appointment.create([
    // Ya se lo hizo en julio, en OTRA sucursal y sin comisión configurada.
    { clinic: otra._id, patient: paciente._id, doctor: doctor._id, date: dia(7, 10), startTime: '09:00', status: 'completada', serviceName: 'HIFU', agreedValue: 100 },
    { clinic: clinic._id, patient: paciente._id, doctor: doctor._id, date: dia(8, 10), startTime: '09:00', status: 'completada', serviceItem: hifu._id, serviceName: 'HIFU', agreedValue: 100 },
    { clinic: clinic._id, patient: nuevo._id, doctor: doctor._id, date: dia(8, 11), startTime: '09:00', status: 'completada', serviceItem: hifu._id, serviceName: 'HIFU', agreedValue: 100 },
    // Segunda vez del paciente nuevo, en el mismo mes: tampoco paga.
    { clinic: clinic._id, patient: nuevo._id, doctor: doctor._id, date: dia(8, 20), startTime: '09:00', status: 'completada', serviceItem: hifu._id, serviceName: 'HIFU', agreedValue: 100 },
  ]);

  const guardado = await llamar(ctrl.saveDoctorServiceRule, reqDe(clinic._id, {
    body: { doctor: String(doctor._id), service: String(hifu._id), clinics: [String(clinic._id)], amountType: 'fixed', value: 20, firstTimeOnly: true },
  }));
  assert.strictEqual(guardado.code, 200);
  assert.strictEqual(guardado.payload.firstTimeOnly, true);

  const resumen = await llamar(ctrl.doctorSummary, reqDe(clinic._id, { query: { start: '2026-08-01', end: '2026-08-31' } }));
  const fila = resumen.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  const svc = fila.services.find((s) => s.serviceId === String(hifu._id));
  assert.strictEqual(svc.commission.firstTimeOnly, true);
  assert.strictEqual(svc.commission.earned, 20, 'solo la primera vez del paciente nuevo paga');
  assert.strictEqual(svc.commission.repeated, 2);
  assert.strictEqual(fila.commissionTotal, 20);
  assert.strictEqual(fila.generated, 300, 'generado = lo que pagaron los pacientes');

  // El reporte general (contabilización) dice lo mismo.
  const reporte = await llamar(ctrl.report, reqDe(clinic._id, { query: { start: '2026-08-01', end: '2026-08-31' } }));
  assert.strictEqual(reporte.payload.total, 20);
});

test('derivación: paga solo cuando el paciente se la REALIZA, y el detalle dice cuáles no', async () => {
  const clinic = await Clinic.create({ name: 'DV', nombreComercial: 'DV', active: true });
  const deriva = await User.create({
    name: 'Deriva Mucho', email: 'deriva@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'doctor' }],
  });
  const eco = await User.create({
    name: 'Eco Grafista', email: 'eco@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'ginecologia' }],
  });
  const paciente = await Patient.create({ clinic: clinic._id, firstName: 'Paciente', lastName: 'Derivado' });
  const ecografia = await AppointmentServiceItem.create({ clinic: clinic._id, name: 'Ecografía', slug: 'ecografia' });
  const laboratorio = await AppointmentServiceItem.create({ clinic: clinic._id, name: 'Laboratorio', slug: 'laboratorio' });
  const consulta = await AppointmentServiceItem.create({ clinic: clinic._id, name: 'Consulta general', slug: 'consulta general' });

  const rec = await ClinicalRecord.create({
    clinic: clinic._id,
    patient: paciente._id,
    followUps: [{
      motivoConsulta: 'Control',
      recetaItems: [
        { name: 'Ecografía', isService: true, serviceItem: ecografia._id },
        { name: 'Laboratorio', isService: true, serviceItem: laboratorio._id },
      ],
    }],
  });
  const origen = await Appointment.create({
    clinic: clinic._id, patient: paciente._id, doctor: deriva._id,
    date: dia(8, 5), startTime: '09:00', status: 'completada',
    serviceItem: consulta._id, serviceName: 'Consulta general', agreedValue: 30,
    turns: [{ kind: 'doctor', user: deriva._id, status: 'completado', followUp: rec.followUps[0]._id }],
  });
  const referral = await Referral.create({
    clinic: clinic._id, patient: paciente._id, fromDoctor: deriva._id, specialty: 'Ecografía', status: 'atendida', date: dia(8, 5),
  });
  const derivada = await Appointment.create({
    clinic: clinic._id, patient: paciente._id, doctor: eco._id,
    date: dia(8, 12), startTime: '10:00', status: 'asistida',
    serviceItem: ecografia._id, serviceName: 'Ecografía', agreedValue: 50,
    origin: 'referral', referral: referral._id, derivationSource: origen._id,
  });
  referral.appointment = derivada._id;
  await referral.save();

  // 10% por cualquier derivación realizada.
  const base = await llamar(ctrl.saveDoctorReferralRule, reqDe(clinic._id, {
    body: { doctor: String(deriva._id), clinics: [String(clinic._id)], amountType: 'percent', value: 10 },
  }));
  assert.strictEqual(base.code, 200);
  // Convive con una base por PACIENTE del mismo doctor (antes chocaba el índice).
  const porPaciente = await llamar(ctrl.saveDoctorPatientRule, reqDe(clinic._id, {
    body: { doctor: String(deriva._id), clinics: [String(clinic._id)], amountType: 'fixed', value: 3 },
  }));
  assert.strictEqual(porPaciente.code, 200);
  assert.strictEqual(await CommissionRule.countDocuments({ doctorServiceDoctor: deriva._id }), 2);

  const q = { start: '2026-08-01', end: '2026-08-31' };
  const resumen = await llamar(ctrl.doctorSummary, reqDe(clinic._id, { query: q }));
  const fila = resumen.payload.doctors.find((d) => d.doctorId === String(deriva._id));
  assert.strictEqual(fila.referralCommission.earned, 5, '10% de los $50 de la ecografía realizada');
  assert.strictEqual(fila.referrals.indicadas, 2);
  assert.strictEqual(fila.referrals.realizadas, 1);
  assert.strictEqual(fila.referrals.sinAgendar, 1, 'el laboratorio no se lo hizo: no paga');
  assert.strictEqual(fila.commissionTotal, 8, '$3 por paciente atendido + $5 por la derivación');
  // La ecografista no gana por la derivación: la cita sí cuenta como suya.
  const filaEco = resumen.payload.doctors.find((d) => d.doctorId === String(eco._id));
  assert.strictEqual(filaEco.commissionTotal, 0);

  // Tarifa propia de la ecografía: reemplaza a la base.
  await llamar(ctrl.saveDoctorReferralRule, reqDe(clinic._id, {
    body: { doctor: String(deriva._id), service: String(ecografia._id), clinics: [String(clinic._id)], amountType: 'fixed', value: 12 },
  }));
  const resumen2 = await llamar(ctrl.doctorSummary, reqDe(clinic._id, { query: q }));
  const fila2 = resumen2.payload.doctors.find((d) => d.doctorId === String(deriva._id));
  assert.strictEqual(fila2.referrals.earned, 12);
  assert.strictEqual(fila2.referralCommission.earned, 0);
  assert.strictEqual(fila2.referralServices.find((s) => s.name === 'Ecografía').commission.earned, 12);

  // Detalle de citas: la cita de origen dice qué derivó y si se realizó.
  const detalle = await llamar(ctrl.doctorAppointments, reqDe(clinic._id, { query: { ...q, doctor: String(deriva._id) } }));
  const filaOrigen = detalle.payload.appointments.find((a) => a.id === String(origen._id));
  const estados = Object.fromEntries(filaOrigen.derivaciones.map((d) => [d.service, d.estado]));
  assert.deepStrictEqual(estados, { Ecografía: 'realizada', Laboratorio: 'sin_agendar' });
  const lista = detalle.payload.referralsByDoctor[String(deriva._id)];
  assert.strictEqual(lista.length, 2, 'el Referral de la ecografía no se repite');
});

test('pagos por período: lo pagado sale de «por pagar», no se solapa y se puede deshacer', async () => {
  const clinic = await Clinic.create({ name: 'PG', nombreComercial: 'PG', active: true });
  const doctor = await User.create({
    name: 'Cobra Quincenal', email: 'quincena@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'cardiologia' }],
  });
  const paciente = await Patient.create({ clinic: clinic._id, firstName: 'Paga', lastName: 'Bien' });
  await Appointment.create([
    { clinic: clinic._id, patient: paciente._id, doctor: doctor._id, date: dia(9, 3), startTime: '09:00', status: 'completada', serviceName: 'Consulta', agreedValue: 40 },
    { clinic: clinic._id, patient: paciente._id, doctor: doctor._id, date: dia(9, 10), startTime: '09:00', status: 'completada', serviceName: 'Consulta', agreedValue: 40 },
    { clinic: clinic._id, patient: paciente._id, doctor: doctor._id, date: dia(9, 20), startTime: '09:00', status: 'asistida', serviceName: 'Consulta', agreedValue: 40 },
  ]);
  await llamar(ctrl.saveDoctorPatientRule, reqDe(clinic._id, {
    body: { doctor: String(doctor._id), clinics: [String(clinic._id)], amountType: 'fixed', value: 10 },
  }));

  const pago = await llamar(ctrl.createPayouts, reqDe(clinic._id, {
    body: { start: '2026-09-01', end: '2026-09-15', clinic: 'all', doctors: [String(doctor._id)], note: 'Primera quincena' },
  }));
  assert.strictEqual(pago.code, 201);
  assert.strictEqual(pago.payload.created[0].amount, 20);

  const q = { start: '2026-09-01', end: '2026-09-30', clinic: 'all' };
  const resumen = await llamar(ctrl.doctorSummary, reqDe(clinic._id, { query: q }));
  const fila = resumen.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila.commissionTotalWithAdjustments, 30);
  assert.strictEqual(fila.paidTotal, 20);
  assert.strictEqual(fila.pendingTotal, 10);
  assert.strictEqual(fila.payouts.length, 1);
  assert.strictEqual(fila.roleInClinic, 'cardiologia');

  // Otro pago que pisa la primera quincena: rechazado.
  const solapado = await llamar(ctrl.createPayouts, reqDe(clinic._id, {
    body: { start: '2026-09-10', end: '2026-09-30', clinic: 'all', doctors: [String(doctor._id)] },
  }));
  assert.strictEqual(solapado.code, 409);

  // Deshacer el pago: vuelve todo a pendiente.
  const borrado = await llamar(ctrl.deletePayout, reqDe(clinic._id, { params: { id: fila.payouts[0].id } }));
  assert.strictEqual(borrado.code, 200);
  const resumen2 = await llamar(ctrl.doctorSummary, reqDe(clinic._id, { query: q }));
  const fila2 = resumen2.payload.doctors.find((d) => d.doctorId === String(doctor._id));
  assert.strictEqual(fila2.paidTotal, 0);
  assert.strictEqual(fila2.pendingTotal, 30);
});

test('filtro de doctores: todas las sucursales, con el rol (general o especialidad)', async () => {
  const a = await Clinic.create({ name: 'FA', nombreComercial: 'FA', active: true });
  const b = await Clinic.create({ name: 'FB', nombreComercial: 'FB', active: true });
  await User.create({ name: 'Zz General', email: 'zzg@test.com', password: '123456', clinics: [{ clinic: a._id, role: 'doctor' }] });
  await User.create({ name: 'Zz Gine', email: 'zzgi@test.com', password: '123456', clinics: [{ clinic: b._id, role: 'ginecologia' }] });
  await User.create({ name: 'Zz Cajero', email: 'zzc@test.com', password: '123456', clinics: [{ clinic: a._id, role: 'cajero' }] });

  const todas = await llamar(ctrl.doctorOptions, reqDe(a._id, { query: { clinic: 'all' } }));
  const nombres = todas.payload.filter((d) => d.name.startsWith('Zz')).map((d) => `${d.name}:${d.roleInClinic}`);
  assert.deepStrictEqual(nombres, ['Zz General:doctor', 'Zz Gine:ginecologia']);

  const soloA = await llamar(ctrl.doctorOptions, reqDe(a._id, { query: { clinic: String(a._id) } }));
  assert.deepStrictEqual(soloA.payload.filter((d) => d.name.startsWith('Zz')).map((d) => d.name), ['Zz General']);
});

test('detalle de citas paginado: la página trae su tramo, los totales y las visitas cuentan el filtro entero', async () => {
  const clinic = await Clinic.create({ name: 'PAG', nombreComercial: 'PAG', active: true });
  const doctor = await User.create({
    name: 'Muchas Citas', email: 'muchas@test.com', password: '123456',
    clinics: [{ clinic: clinic._id, role: 'doctor' }],
  });
  const paciente = await Patient.create({ clinic: clinic._id, firstName: 'Siempre', lastName: 'Viene' });
  await Appointment.create([1, 2, 3, 4, 5].map((d) => ({
    clinic: clinic._id, patient: paciente._id, doctor: doctor._id,
    date: dia(10, d), startTime: '09:00', status: 'completada', serviceName: 'Consulta', agreedValue: 10,
  })));

  const q = { start: '2026-10-01', end: '2026-10-31', doctor: String(doctor._id), limit: '2', page: '3' };
  const res = await llamar(ctrl.doctorAppointments, reqDe(clinic._id, { query: q }));
  assert.strictEqual(res.payload.appointments.length, 1, 'la tercera página de 2 en 2 trae la quinta cita');
  assert.deepStrictEqual(res.payload.pagination, { page: 3, limit: 2, total: 5, pages: 3 });
  assert.strictEqual(res.payload.totals.appointments, 5);
  assert.strictEqual(res.payload.totals.payments, 50);
  assert.strictEqual(res.payload.appointments[0].visitNumber, 5);
  assert.strictEqual(res.payload.appointments[0].visitsTotal, 5);

  // Sin `limit`, todas como antes.
  const todas = await llamar(ctrl.doctorAppointments, reqDe(clinic._id, { query: { ...q, limit: undefined, page: undefined } }));
  assert.strictEqual(todas.payload.appointments.length, 5);
});
