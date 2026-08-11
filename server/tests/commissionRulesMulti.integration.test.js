/**
 * REGLAS DE COMISIÓN CON VARIOS VALORES.
 *
 * Una misma regla puede nombrar VARIAS personas, VARIAS condiciones (eventos) y VARIOS
 * productos. Antes cada una de esas cosas era un único valor y había que duplicar la
 * regla; lo que se comprueba aquí es que la regla nueva paga a todos los que nombra y
 * que las reglas ANTIGUAS (campo singular) siguen calculando exactamente igual.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const commissions = require('../controllers/commissionController');
const CommissionRule = require('../models/CommissionRule');
const Appointment = require('../models/Appointment');
const User = require('../models/User');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const HOY = new Date();
const rango = { start: new Date(HOY.getFullYear(), HOY.getMonth(), 1).toISOString().slice(0, 10),
  end: new Date(HOY.getFullYear(), HOY.getMonth() + 1, 0).toISOString().slice(0, 10) };

const hacerUsuario = (clinicId, name, role) => User.create({
  name, email: `${name.toLowerCase()}@example.com`, password: 'secreto1',
  clinics: [{ clinic: clinicId, role }],
});

/** Cita COMPLETADA atendida por `doctor`, con un servicio y su precio. */
const citaAtendida = (clinicId, doctor, patient, servicio, price) => Appointment.create({
  clinic: clinicId, patient: patient._id, doctor: doctor._id,
  date: HOY, startTime: '10:00', endTime: '10:30', status: 'completada',
  services: [{ product: servicio._id, name: servicio.name, price }],
  createdBy: doctor._id,
});

const reporte = (clinicId, userId) => H.runController(
  commissions.report,
  H.mockReq(clinicId, userId, {}, { query: rango })
);

async function escenario() {
  const { clinicId, userId } = await H.seedClinic();
  const Patient = require('../models/Patient');
  const paciente = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Perez', cedula: '0102030405' });
  const ana = await hacerUsuario(clinicId, 'Ana', 'doctor');
  const luis = await hacerUsuario(clinicId, 'Luis', 'doctor');
  const consulta = await H.makeProduct(clinicId, { name: 'Consulta', category: 'servicio', unlimited: true, salePrice: 50 });
  const eco = await H.makeProduct(clinicId, { name: 'Ecografia', category: 'servicio', unlimited: true, salePrice: 80 });
  return { clinicId, userId, paciente, ana, luis, consulta, eco };
}

// ─────────────────────────────────────────────────────────────────────────────
test('una regla con VARIAS personas paga a todas', async () => {
  const { clinicId, userId, paciente, ana, luis, consulta } = await escenario();
  await citaAtendida(clinicId, ana, paciente, consulta, 50);
  await citaAtendida(clinicId, luis, paciente, consulta, 50);

  await CommissionRule.create({
    clinic: clinicId, name: 'Doctores del turno', targetType: 'user',
    users: [ana._id, luis._id], user: ana._id,
    triggers: ['appointment_performed'], trigger: 'appointment_performed',
    amountType: 'fixed', amount: 10,
  });

  const r = await reporte(clinicId, userId);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const porNombre = Object.fromEntries(r.payload.byUser.map((u) => [u.userName, u.total]));
  assert.deepEqual(porNombre, { Ana: 10, Luis: 10 }, 'las dos personas nombradas cobran');
});

test('una regla con VARIAS condiciones paga por cada una', async () => {
  const { clinicId, userId, paciente, ana, consulta } = await escenario();
  await citaAtendida(clinicId, ana, paciente, consulta, 50);

  const Sale = require('../models/Sale');
  await Sale.create({
    clinic: clinicId, saleNumber: 'V-1', status: 'completada', paymentMethod: 'efectivo',
    items: [{ product: consulta._id, productName: 'Consulta', quantity: 1, unitPrice: 50, subtotal: 50, lineTotal: 50 }],
    subtotal: 50, taxAmount: 0, total: 50, createdBy: ana._id, recommendedBy: ana._id,
  });

  await CommissionRule.create({
    clinic: clinicId, name: 'Atiende y recomienda', targetType: 'user',
    users: [ana._id], user: ana._id,
    triggers: ['appointment_performed', 'recommendation'], trigger: 'appointment_performed',
    amountType: 'fixed', amount: 5,
  });

  const r = await reporte(clinicId, userId);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const fuentes = r.payload.detail.map((d) => d.source).sort();
  assert.deepEqual(fuentes, ['cita atendida', 'recomendación'], 'cobra por las dos condiciones');
  assert.equal(r.payload.byUser[0].total, 10);
});

test('una regla con VARIOS productos aplica solo a esos', async () => {
  const { clinicId, userId, paciente, ana, consulta, eco } = await escenario();
  const otro = await H.makeProduct(clinicId, { name: 'Curacion', category: 'servicio', unlimited: true, salePrice: 20 });
  await citaAtendida(clinicId, ana, paciente, consulta, 50);
  await citaAtendida(clinicId, ana, paciente, eco, 80);
  await citaAtendida(clinicId, ana, paciente, otro, 20);

  await CommissionRule.create({
    clinic: clinicId, name: 'Consulta y eco', targetType: 'user',
    users: [ana._id], user: ana._id,
    triggers: ['appointment_performed'], trigger: 'appointment_performed',
    services: [consulta._id, eco._id], service: consulta._id,
    amountType: 'fixed', amount: 7,
  });

  const r = await reporte(clinicId, userId);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  const servicios = r.payload.detail.map((d) => d.service).sort();
  assert.deepEqual(servicios, ['Consulta', 'Ecografia'], 'la curación queda fuera');
  assert.equal(r.payload.byUser[0].total, 14);
});

test('una regla ANTIGUA (campos singulares) sigue calculando igual', async () => {
  const { clinicId, userId, paciente, ana, luis, consulta, eco } = await escenario();
  await citaAtendida(clinicId, ana, paciente, consulta, 50);
  await citaAtendida(clinicId, luis, paciente, consulta, 50);
  await citaAtendida(clinicId, ana, paciente, eco, 80);

  // Tal como la creaba la versión anterior: sin `users`, `triggers` ni `services`.
  await CommissionRule.collection.insertOne({
    clinic: new H.mongoose.Types.ObjectId(String(clinicId)),
    name: 'Regla vieja', active: true, targetType: 'user',
    user: new H.mongoose.Types.ObjectId(String(ana._id)),
    trigger: 'appointment_performed',
    service: new H.mongoose.Types.ObjectId(String(consulta._id)),
    amountType: 'fixed', amount: 12, percent: 0, patientScope: 'all',
    scheduleEnabled: false, daysOfWeek: [], serviceAmounts: [],
  });

  const r = await reporte(clinicId, userId);
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(r.payload.detail.length, 1, 'solo Ana y solo por la consulta');
  assert.equal(r.payload.detail[0].userName, 'Ana');
  assert.equal(r.payload.detail[0].service, 'Consulta');
  assert.equal(r.payload.byUser[0].total, 12);
});

test('al guardar, el campo singular queda sincronizado con el primero de la lista', async () => {
  const { clinicId, userId, ana, luis, consulta, eco } = await escenario();

  const creada = await H.runController(commissions.createRule, H.mockReq(clinicId, userId, {
    name: 'Multi', targetType: 'user',
    users: [String(luis._id), String(ana._id)],
    triggers: ['recommendation', 'sale'],
    services: [String(eco._id), String(consulta._id)],
    amountType: 'fixed', amount: 3,
  }));

  assert.equal(creada.statusCode, 201, JSON.stringify(creada.payload));
  const guardada = await CommissionRule.findById(creada.payload._id);
  assert.equal(String(guardada.user), String(luis._id), 'el singular es el primero de la lista');
  assert.equal(guardada.trigger, 'recommendation');
  assert.equal(String(guardada.service), String(eco._id));
  assert.equal(guardada.users.length, 2);
  assert.equal(guardada.triggers.length, 2);
  assert.equal(guardada.services.length, 2);

  // Cambiar a "por rol" no debe dejar personas colgando.
  const editada = await H.runController(commissions.updateRule, H.mockReq(clinicId, userId, {
    name: 'Multi', targetType: 'role', role: 'doctor', users: [String(ana._id)],
  }, { params: { id: String(creada.payload._id) } }));
  assert.equal(editada.statusCode, 200, JSON.stringify(editada.payload));
  assert.equal(editada.payload.users.length, 0);
  assert.equal(editada.payload.user, null);
});
