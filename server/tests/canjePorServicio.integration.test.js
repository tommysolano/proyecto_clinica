/**
 * CANJE / CORTESÍA DE UN SOLO SERVICIO (oct-2026).
 *
 * Una visita con varios servicios: la consulta se paga y el suero es cortesía.
 * Antes la marca era de la visita entera y no había cómo decirlo. Se vigila:
 *
 *  1. Un servicio sin cobro y otro cobrado → la visita SE COBRA (no es canje),
 *     con su valor, y la lista dice cuál no se cobra.
 *  2. Todos sin cobro → la visita entera es canje (o cortesía si todos lo son).
 *  3. Quitar el servicio marcado no deja su canje colgado.
 *  4. Una lista con servicios que no son de la cita se ignora.
 *  5. El servicio sin cobro no cuenta para las sesiones prepagadas.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const appt = require('../controllers/appointmentController');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const { tipoSinCobroDelServicio } = require('../utils/appointmentValue');
const { productosDeCitas } = require('../utils/sesionesPrepagadas');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const HOY = new Date();
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });
  const servicio = (name) =>
    AppointmentServiceItem.create({ clinic: clinicId, name, slug: AppointmentServiceItem.slugify(name) });
  const consulta = await servicio('Consulta');
  const suero = await servicio('Suero');
  const apt = await Appointment.create({
    clinic: clinicId,
    patient: patient._id,
    date: new Date(`${ymd(HOY)}T12:00:00`),
    startTime: '12:40',
    status: 'pendiente',
    serviceItem: consulta._id,
    serviceName: 'Consulta',
    additionalServices: [{ serviceItem: suero._id, name: 'Suero' }],
    createdBy: userId,
  });
  return { clinicId, userId, consulta, suero, apt };
}

const guardar = (s, body) =>
  H.runController(
    appt.updateServiceAndValue,
    H.mockReq(s.clinicId, s.userId, body, { role: 'cajero', params: { id: String(s.apt._id) } })
  );
const ok = (r) => {
  assert.equal(r.statusCode, 200, `esperaba éxito: ${JSON.stringify(r.payload)}`);
  return r;
};
const leer = async (s) => Appointment.findById(s.apt._id).lean();

test('un servicio en cortesía y otro cobrado: la visita se cobra', async () => {
  const s = await seed();
  ok(await guardar(s, {
    agreedValue: 25,
    noChargeServices: [{ serviceItem: String(s.suero._id), kind: 'cortesia' }],
  }));
  const a = await leer(s);
  assert.equal(a.isCanje, false);
  assert.equal(a.isCortesia, false);
  assert.equal(a.agreedValue, 25, 'el valor es el de lo que sí se cobra');
  assert.equal(a.noChargeServices.length, 1);
  assert.equal(tipoSinCobroDelServicio(a, s.suero._id), 'cortesia');
  assert.equal(tipoSinCobroDelServicio(a, s.consulta._id), '');
});

test('todos sin cobro: la visita entera queda como canje (o cortesía)', async () => {
  const s = await seed();
  ok(await guardar(s, {
    agreedValue: 40,
    noChargeServices: [
      { serviceItem: String(s.suero._id), kind: 'cortesia' },
      { serviceItem: String(s.consulta._id), kind: 'canje' },
    ],
  }));
  let a = await leer(s);
  assert.equal(a.isCanje, true);
  assert.equal(a.agreedValue, 0, 'sin dinero no hay importe');

  ok(await guardar(s, {
    noChargeServices: [
      { serviceItem: String(s.suero._id), kind: 'cortesia' },
      { serviceItem: String(s.consulta._id), kind: 'cortesia' },
    ],
  }));
  a = await leer(s);
  assert.equal(a.isCortesia, true);
  assert.equal(a.isCanje, false);

  // Y vuelve a cobrarse si se desmarca uno.
  ok(await guardar(s, {
    agreedValue: 20,
    noChargeServices: [{ serviceItem: String(s.suero._id), kind: 'cortesia' }],
  }));
  a = await leer(s);
  assert.equal(a.isCortesia, false);
  assert.equal(a.agreedValue, 20);
});

test('quitar el servicio marcado no deja su canje colgado', async () => {
  const s = await seed();
  ok(await guardar(s, { agreedValue: 25, noChargeServices: [{ serviceItem: String(s.suero._id), kind: 'canje' }] }));
  ok(await guardar(s, { additionalServices: [] }));
  const a = await leer(s);
  assert.equal(a.noChargeServices.length, 0);
  assert.equal(a.isCanje, false, 'lo que queda (la consulta) se cobra');
});

test('si se quita el servicio cobrado, el que queda sin cobro marca la visita', async () => {
  const s = await seed();
  ok(await guardar(s, { agreedValue: 25, noChargeServices: [{ serviceItem: String(s.suero._id), kind: 'cortesia' }] }));
  ok(await guardar(s, { serviceItem: String(s.suero._id), additionalServices: [] }));
  const a = await leer(s);
  assert.equal(a.isCortesia, true);
  assert.equal(a.agreedValue, 0);
});

test('un servicio que no es de la cita se ignora', async () => {
  const s = await seed();
  ok(await guardar(s, {
    noChargeServices: [{ serviceItem: String(s.clinicId), kind: 'canje' }],
  }));
  const a = await leer(s);
  assert.equal(a.noChargeServices.length, 0);
  assert.equal(a.isCanje, false);
});

test('el servicio sin cobro no cuenta para las sesiones prepagadas', async () => {
  const s = await seed();
  const prodConsulta = await H.makeProduct(s.clinicId, { code: 'CONS', name: 'Consulta' });
  const prodSuero = await H.makeProduct(s.clinicId, { code: 'SUE', name: 'Suero' });
  await AppointmentServiceItem.updateOne({ _id: s.consulta._id }, { product: prodConsulta._id });
  await AppointmentServiceItem.updateOne({ _id: s.suero._id }, { product: prodSuero._id });
  ok(await guardar(s, { agreedValue: 25, noChargeServices: [{ serviceItem: String(s.suero._id), kind: 'canje' }] }));
  const a = await leer(s);
  const productos = (await productosDeCitas([a])).get(String(a._id));
  assert.deepEqual(productos, [String(prodConsulta._id)]);
});
