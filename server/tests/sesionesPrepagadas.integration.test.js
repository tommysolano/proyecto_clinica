/**
 * SESIONES PREPAGADAS (oct-2026). El paciente paga hoy 5 sueroterapias: la de
 * hoy y 4 para después. La venta es una sola; lo que queda es su saldo de
 * sesiones. Al asignar la atención de la próxima cita no se le vuelve a cobrar:
 * se gasta una sesión y la cita dice «Sesión 2 de 5».
 *
 * Y el DESCUENTO ya no se teclea al cobrar: lo pone el producto (inventario).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const Patient = require('../models/Patient');
const User = require('../models/User');
const Sale = require('../models/Sale');
const PrepaidService = require('../models/PrepaidService');
const sales = require('../controllers/saleController');
const appt = require('../controllers/appointmentController');
const patients = require('../controllers/patientController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId } = await H.seedClinic();
  const cajero = await User.create({
    name: 'Carla', email: `carla${Date.now()}@t.com`, password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'cajero' }], canBill: true,
  });
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405' });
  const suero = await H.makeProduct(clinicId, {
    name: 'Sueroterapia', category: 'servicio', unlimited: true, salePrice: 50, taxCategory: 'IVA_0', taxRate: 0,
  });
  const svc = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Sueroterapia', slug: AppointmentServiceItem.slugify('Sueroterapia'), product: suero._id,
  });
  const nuevaCita = (extra = {}) => Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
    reason: 'Suero', serviceItem: svc._id, serviceName: 'Sueroterapia', ...extra,
  });
  return { clinicId, cajero, patient, suero, svc, nuevaCita };
}

const comoCajero = (clinicId, cajero, body = {}, extra = {}) => {
  const req = H.mockReq(clinicId, cajero._id, body, { role: 'cajero', ...extra });
  req.user = { ...cajero.toObject(), _id: cajero._id };
  return req;
};

const cobrar = (s, cita, items) => H.runController(sales.createSale, comoCajero(s.clinicId, s.cajero, {
  date: H.docDate(),
  patient: String(s.patient._id),
  appointment: cita ? String(cita._id) : undefined,
  clientName: 'Ana Pérez',
  clientCedula: '0102030405',
  paymentMethod: 'efectivo',
  items,
}));

const asistio = (s, cita) => H.runController(appt.markAttended, comoCajero(s.clinicId, s.cajero, {}, { params: { id: String(cita._id) } }));
const leerCita = (s, cita) => H.runController(appt.getAppointment, comoCajero(s.clinicId, s.cajero, {}, { params: { id: String(cita._id) } }));

const usos = (r) => (r.payload.sesiones || []).map((x) => (x.apartada ? 'apartada' : `${x.n} de ${x.total}`));
const manana = () => { const d = new Date(Date.now() + 86400000); d.setHours(12, 0, 0, 0); return d; };
const asignarEnfermeria = (s, cita) => H.runController(appt.assignDoctor, comoCajero(s.clinicId, s.cajero,
  { steps: [{ kind: 'enfermeria' }] }, { params: { id: String(cita._id) } }));

test('se paga 5 en la primera cita: cuenta «1 de 5» cuando se atiende, y la siguiente no se cobra: «2 de 5»', async () => {
  const s = await seed();
  const c1 = await s.nuevaCita();
  const v = await cobrar(s, c1, [{ product: String(s.suero._id), quantity: 5, prepaid: true }]);
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.total, 250);

  const paquete = await PrepaidService.findOne({ sale: v.payload._id });
  assert.ok(paquete, 'debe quedar el paquete de sesiones');
  assert.equal(paquete.quantity, 5);
  assert.equal(paquete.uses.length, 1);

  // Cobrada pero sin atender: la sesión está APARTADA, todavía no cuenta.
  assert.deepEqual(usos(await leerCita(s, c1)), ['apartada']);
  await asistio(s, c1);
  assert.deepEqual(usos(await leerCita(s, c1)), ['1 de 5']);

  // La segunda cita: mostrador ve que está prepagada entera, no hay que cobrar.
  const c2 = await s.nuevaCita({ startTime: '11:00' });
  const antes = await leerCita(s, c2);
  assert.equal(antes.payload.prepago.todo, true);
  assert.equal(antes.payload.prepago.cubre[0].quedan, 4);

  const a = await asistio(s, c2);
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  assert.deepEqual(usos(await leerCita(s, c2)), ['2 de 5']);

  // Volver a marcar NO toma otra sesión.
  await asistio(s, c2);
  assert.equal((await PrepaidService.findById(paquete._id)).uses.length, 2);
  assert.equal(await Sale.countDocuments({}), 1, 'no se cobró otra vez');
});

test('cita FUTURA asignada por adelantado: no se cobra, aparta la sesión y no cuenta hasta que se atienda', async () => {
  const s = await seed();
  await cobrar(s, null, [{ product: String(s.suero._id), quantity: 2, prepaid: true }]);
  const futura = await s.nuevaCita({ date: manana(), startTime: '10:00' });

  const r0 = await leerCita(s, futura);
  assert.equal(r0.payload.prepago.todo, true, 'aparece directo para asignar, sin cobro');

  const a = await asignarEnfermeria(s, futura);
  assert.equal(a.statusCode, 200, JSON.stringify(a.payload));
  assert.equal((await Appointment.findById(futura._id)).status, 'pendiente', 'una cita de mañana no se da por asistida');
  const r1 = await leerCita(s, futura);
  assert.deepEqual(usos(r1), ['apartada']);
  assert.equal(r1.payload.prepago.todo, true, 'sigue sin pedir cobro');

  // Perfil: 0 usadas (no se atendió), 1 apartada, 1 libre.
  const perfil = await H.runController(patients.getPatientPrepaid, comoCajero(s.clinicId, s.cajero, {}, { params: { id: String(s.patient._id) } }));
  assert.deepEqual([perfil.payload[0].usadas, perfil.payload[0].apartadas, perfil.payload[0].quedan], [0, 1, 1]);

  // El doctor la cierra mañana (completada) sin pasar por mostrador: cuenta.
  await Appointment.updateOne({ _id: futura._id }, { $set: { status: 'completada' } });
  assert.deepEqual(usos(await leerCita(s, futura)), ['1 de 2']);
});

test('una cita CANCELADA no cuenta: su sesión vuelve al paciente', async () => {
  const s = await seed();
  const c1 = await s.nuevaCita();
  await cobrar(s, c1, [{ product: String(s.suero._id), quantity: 2, prepaid: true }]);
  await asistio(s, c1);
  const c2 = await s.nuevaCita({ date: manana(), startTime: '11:00' });
  await asignarEnfermeria(s, c2);
  let c3 = await s.nuevaCita({ date: manana(), startTime: '12:00' });
  assert.equal((await leerCita(s, c3)).payload.prepago, undefined, 'las 2 están tomadas (1 usada, 1 apartada)');

  // El paciente cancela la cita 2: no recibió la atención, no cuenta.
  await Appointment.updateOne({ _id: c2._id }, { $set: { status: 'cancelada' } });
  assert.deepEqual(usos(await leerCita(s, c2)), []);
  c3 = await Appointment.findById(c3._id);
  const r = await leerCita(s, c3);
  assert.equal(r.payload.prepago.cubre[0].quedan, 1);
  await asignarEnfermeria(s, c3);
  await Appointment.updateOne({ _id: c3._id }, { $set: { status: 'asistida' } });
  assert.deepEqual(usos(await leerCita(s, c3)), ['2 de 2']);

  // Y una cita NO ASISTIDA tampoco cuenta.
  await Appointment.updateOne({ _id: c3._id }, { $set: { status: 'no_asistio' } });
  const perfil = await H.runController(patients.getPatientPrepaid, comoCajero(s.clinicId, s.cajero, {}, { params: { id: String(s.patient._id) } }));
  assert.deepEqual([perfil.payload[0].usadas, perfil.payload[0].quedan], [1, 1]);
});

test('sin marcar «para citas futuras», cobrar 2 no deja paquete', async () => {
  const s = await seed();
  const c1 = await s.nuevaCita();
  const v = await cobrar(s, c1, [{ product: String(s.suero._id), quantity: 2 }]);
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(await PrepaidService.countDocuments({}), 0);
});

test('vendido desde Ventas (sin cita): las sesiones quedan todas para después', async () => {
  const s = await seed();
  const v = await cobrar(s, null, [{ product: String(s.suero._id), quantity: 3, prepaid: true }]);
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  const p = await PrepaidService.findOne({});
  assert.equal(p.quantity, 3);
  assert.equal(p.uses.length, 0);
  const c = await s.nuevaCita();
  await asistio(s, c);
  assert.deepEqual(usos(await leerCita(s, c)), ['1 de 3']);
});

test('anular la venta: no se deja si ya se usaron sesiones en otras citas', async () => {
  const s = await seed();
  const c1 = await s.nuevaCita();
  const v = await cobrar(s, c1, [{ product: String(s.suero._id), quantity: 3, prepaid: true }]);
  const c2 = await s.nuevaCita({ startTime: '11:00' });
  await asistio(s, c2);

  const anular = () => H.runController(sales.cancelSale, comoCajero(s.clinicId, s.cajero, {}, { params: { id: String(v.payload._id) } }));
  const r = await anular();
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.error, /sesiones prepagadas/);

  // Sin usos en otras citas, sí se anula y el paquete con ella.
  await Appointment.updateOne({ _id: c2._id }, { $set: { status: 'cancelada' } });
  const ok = await anular();
  assert.equal(ok.statusCode, 200, JSON.stringify(ok.payload));
  assert.equal((await PrepaidService.findOne({ sale: v.payload._id })).status, 'anulado');
});

test('el descuento lo pone el producto; el que manda la pantalla se ignora', async () => {
  const s = await seed();
  await s.suero.updateOne({ discountType: 'percentage', discountValue: 10 });
  const v = await cobrar(s, null, [{ product: String(s.suero._id), quantity: 2, discount: 80 }]);
  assert.equal(v.statusCode, 201, JSON.stringify(v.payload));
  assert.equal(v.payload.discountTotal, 10); // 10 % de 100
  assert.equal(v.payload.total, 90);

  await s.suero.updateOne({ discountType: 'amount', discountValue: 5 });
  const v2 = await cobrar(s, null, [{ product: String(s.suero._id), quantity: 3 }]);
  assert.equal(v2.payload.discountTotal, 15); // $5 por unidad
  assert.equal(v2.payload.total, 135);
});

test('la pestaña Facturas del paciente lista sus ventas con o sin factura', async () => {
  const s = await seed();
  await cobrar(s, null, [{ product: String(s.suero._id), quantity: 1 }]);
  const r = await H.runController(patients.getPatientInvoices, comoCajero(s.clinicId, s.cajero, {}, { params: { id: String(s.patient._id) } }));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.length, 1);
  assert.equal(r.payload[0].invoice, null);
  assert.equal(r.payload[0].items[0].name, 'Sueroterapia');
});
