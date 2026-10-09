/**
 * ANALÍTICAS DEL CRM POR PROGRAMA DE PUBLICIDAD (oct-2026).
 *
 * Programa = gasto por mes + anuncios (ids de las automatizaciones) + servicios
 * del inventario. Lo que se vigila: que cada cita creada desde el chat caiga en
 * su programa, que se cuente cómo terminó, y que el ingreso deje fuera los
 * canjes, los servicios que no generan ingresos y lo que no se atendió.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const Conversation = require('../models/Conversation');
const Patient = require('../models/Patient');
const Workflow = require('../models/Workflow');
require('../models/Clinic');
const ctrl = require('../controllers/adProgramController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };
const hoy = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const mes = () => hoy().slice(0, 7);

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const detox = await AppointmentServiceItem.create({ clinic: clinicId, name: 'Detox Plus', slug: 'detox-plus' });
  const valoracion = await AppointmentServiceItem.create({ clinic: clinicId, name: 'Valoración', slug: 'valoracion' });
  const otro = await AppointmentServiceItem.create({ clinic: clinicId, name: 'Ecografía', slug: 'eco' });
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Vera' });
  return { clinicId, userId, detox, valoracion, otro, patient };
}

const chat = (clinicId, patient, adId = '') => Conversation.create({
  clinic: clinicId, phone: `5939${Math.floor(Math.random() * 1e8)}`, patient: patient._id,
  attribution: { adId },
});

const cita = (clinicId, patient, conv, servicio, extra = {}) => Appointment.create({
  clinic: clinicId, patient: patient._id, conversation: conv._id, date: new Date(), startTime: '10:00',
  serviceItem: servicio._id, serviceName: servicio.name, ...extra,
});

const pedir = (clinicId, userId, body = {}, extra = {}) => H.mockReq(clinicId, userId, body, extra);

test('los anuncios de cada automatización se ofrecen en bloque', async () => {
  const { clinicId, userId } = await seed();
  await Workflow.create({
    clinic: clinicId, name: 'Detox anuncios', active: true,
    nodes: [{ id: 't', type: 'trigger', data: { triggers: [{ type: 'ctwa_ad', adFilter: '111, 222' }] } }],
  });
  await Workflow.create({
    clinic: clinicId, name: 'Sin anuncio', active: true,
    triggers: [{ type: 'keyword', keywords: ['hola'] }],
  });
  const fuentes = ok(await H.runController(ctrl.adSources, pedir(clinicId, userId)));
  assert.equal(fuentes.length, 1);
  assert.deepEqual(fuentes[0].adIds, ['111', '222']);
});

test('un anuncio no puede estar en dos programas', async () => {
  const { clinicId, userId } = await seed();
  ok(await H.runController(ctrl.create, pedir(clinicId, userId, { name: 'Detox', anuncios: [{ adId: '111' }] })));
  const r = await H.runController(ctrl.create, pedir(clinicId, userId, { name: 'Otro', anuncios: [{ adId: '111' }] }));
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /Detox/);
});

test('citas por programa: estados, ingresos, canjes y servicios sin ingreso', async () => {
  const { clinicId, userId, detox, valoracion, otro, patient } = await seed();
  const prog = ok(await H.runController(ctrl.create, pedir(clinicId, userId, {
    name: 'Detox',
    gastos: [{ mes: mes(), monto: 100 }, { mes: '2001-01', monto: 999 }],
    anuncios: [{ adId: 'AD1' }],
    servicios: [
      { serviceItem: String(detox._id), name: detox.name },
      { serviceItem: String(valoracion._id), name: valoracion.name, generaIngresos: false },
    ],
  })));

  const c1 = await chat(clinicId, patient, 'AD1');
  await cita(clinicId, patient, c1, detox, { status: 'completada', agreedValue: 80 });
  await cita(clinicId, patient, c1, detox, { status: 'asistida', agreedValue: 0, isCanje: true });
  await cita(clinicId, patient, c1, valoracion, { status: 'asistida', agreedValue: 20 });
  await cita(clinicId, patient, c1, detox, { status: 'cancelada', agreedValue: 50 });
  await cita(clinicId, patient, c1, detox, { status: 'no_asistio' });
  await cita(clinicId, patient, c1, detox, { status: 'pendiente', agreedValue: 40 });

  // Chat SIN anuncio pero con un servicio del programa: cae por servicio.
  const c2 = await chat(clinicId, patient, '');
  await cita(clinicId, patient, c2, detox, { status: 'pendiente' });
  // Chat sin anuncio y con un servicio de ningún programa: sin programa.
  await cita(clinicId, patient, c2, otro, { status: 'pendiente' });
  // Cita de la agenda (sin chat): no cuenta.
  await Appointment.create({ clinic: clinicId, patient: patient._id, date: new Date(), startTime: '11:00', serviceItem: detox._id });

  const r = ok(await H.runController(ctrl.analytics, pedir(clinicId, userId, {}, { query: { from: hoy(), to: hoy() } })));
  const p = r.programas.find((x) => String(x._id) === String(prog._id));
  assert.equal(p.citas, 7);
  assert.equal(p.efectivas, 3);
  assert.equal(p.canceladas, 1);
  assert.equal(p.noAsistio, 1);
  assert.equal(p.pendientes, 2);
  assert.equal(p.canjes, 1);
  assert.equal(p.sinIngreso, 1, 'la valoración no genera ingresos');
  assert.equal(p.ingresos, 80, 'solo lo atendido, sin canje ni servicio sin ingreso');
  assert.equal(p.valorAgendado, 120, 'lo que sigue en pie: 80 + 40');
  assert.equal(p.gasto, 100, 'solo el gasto de los meses del rango');
  assert.equal(p.costoPorEfectiva, 100 / 3);
  assert.equal(p.citasDetalle.filter((d) => d.atribucion === 'servicio').length, 1);
  assert.equal(r.sinPrograma.citas, 1);
});
