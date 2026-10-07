/**
 * Oct-2026, a pedido de la clínica:
 *  · La hidroterapia que marca mostrador la puede dar por realizada cualquier
 *    enfermero de la cita (antes solo el dueño de un turno pendiente), y volver
 *    a guardar la asignación no borra esa constancia.
 *  · Las ampollas y moléculas del suero salen del INVENTARIO (categoría
 *    AMPOLLAS / MOLÉCULAS), y su código es el del producto: el saneo no lo
 *    cambia por el del catálogo fijo aunque el nombre coincida.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const InventoryCategory = require('../models/InventoryCategory');
const appt = require('../controllers/appointmentController');
const products = require('../controllers/productController');
const { saneaSueroPlano } = require('../utils/suero');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Hidro', cedula: '0102030499',
  });
  const crear = (name) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role: 'enfermero' }],
    });
  const enfA = await crear('EnfA');
  const enfB = await crear('EnfB');
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });
  return { clinicId, userId, enfA, enfB, cita };
}

const comoCita = (clinicId, userId, id, role, body = {}) =>
  H.mockReq(clinicId, userId, body, { role, params: { id: String(id) } });

test('cualquier enfermero marca la hidroterapia, y reasignar no la borra', async () => {
  const { clinicId, userId, enfA, enfB, cita } = await seed();

  // Paso nombrado a EnfA con hidroterapia.
  await H.runController(appt.assignDoctor, comoCita(clinicId, userId, cita._id, 'cajero', {
    steps: [{ kind: 'enfermeria', user: String(enfA._id), hidroterapia: true }],
  }));

  // EnfB no tiene turno en la cita y aun así puede dar fe.
  const r = await H.runController(
    appt.marcarHidroterapia,
    comoCita(clinicId, enfB._id, cita._id, 'enfermero', { realizada: true }),
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  let guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.turns[0].hidroterapia.realizada, true);
  assert.equal(String(guardada.turns[0].hidroterapia.realizadaBy), String(enfB._id));

  // Mostrador vuelve a guardar la asignación: la hidro sigue realizada.
  await H.runController(appt.assignDoctor, comoCita(clinicId, userId, cita._id, 'cajero', {
    steps: [{ kind: 'enfermeria', user: String(enfA._id), hidroterapia: true, nurseInstructions: 'despacio' }],
  }));
  guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.turns[0].hidroterapia.realizada, true, 'reasignar no borra la constancia');

  // Y se puede desmarcar.
  const d = await H.runController(
    appt.marcarHidroterapia,
    comoCita(clinicId, enfA._id, cita._id, 'enfermero', { realizada: false }),
  );
  assert.equal(d.statusCode, 200);
  guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.turns[0].hidroterapia.realizada, false);
});

test('una cita sin hidroterapia no se deja marcar', async () => {
  const { clinicId, userId, enfA, cita } = await seed();
  await H.runController(appt.assignDoctor, comoCita(clinicId, userId, cita._id, 'cajero', {
    steps: [{ kind: 'enfermeria', user: String(enfA._id), nurseInstructions: 'signos' }],
  }));
  const r = await H.runController(
    appt.marcarHidroterapia,
    comoCita(clinicId, enfA._id, cita._id, 'enfermero', { realizada: true }),
  );
  assert.equal(r.statusCode, 400);
});

test('las ampollas y moléculas del suero salen del inventario por su categoría', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const cat = (name, code) =>
    InventoryCategory.create({ clinic: clinicId, code, name, kind: 'INVENTARIO' });
  const ampollas = await cat('AMPOLLAS', 'AMP');
  const moleculas = await cat('Moléculas', 'MOL');
  const tabletas = await cat('TABLETAS', 'TAB');

  await H.makeProduct(clinicId, { code: 'AMP1', name: 'VITAMINA C 10ML', inventoryCategory: ampollas._id, stock: 7 });
  await H.makeProduct(clinicId, { code: 'MOL1', name: 'GLUTATION MOL', inventoryCategory: moleculas._id });
  await H.makeProduct(clinicId, { code: 'TAB1', name: 'IBUPROFENO', inventoryCategory: tabletas._id });
  // Producto viejo: solo el texto legacy `categoria`.
  await H.makeProduct(clinicId, { code: 'LEG1', name: 'COMPLEJO B', categoria: 'AMPOLLAS', inventoryCategory: null });
  await H.makeProduct(clinicId, { code: 'OFF1', name: 'BAJA', inventoryCategory: ampollas._id, active: false });

  const r = await H.runController(
    products.getSueroComponentes,
    H.mockReq(clinicId, userId, {}, { role: 'doctor' }),
  );
  assert.equal(r.statusCode, 200);
  const porCodigo = Object.fromEntries(r.payload.map((o) => [o.code, o]));
  assert.deepEqual(Object.keys(porCodigo).sort(), ['AMP1', 'LEG1', 'MOL1']);
  assert.equal(porCodigo.AMP1.grupo, 'ampolla');
  assert.equal(porCodigo.AMP1.stock, 7);
  assert.equal(porCodigo.MOL1.grupo, 'molecula');
  assert.equal(porCodigo.LEG1.grupo, 'ampolla');
});

test('el saneo conserva el código del producto aunque el nombre esté en el catálogo fijo', () => {
  const s = saneaSueroPlano({
    base: { volumeMl: 250 },
    components: [
      // Nombre del catálogo fijo, pero con el código del producto del inventario.
      { code: 'P00042', name: 'CELLVITALIS', grupo: 'molecula', quantity: 2 },
      // Sin código: se sigue resolviendo por nombre contra el catálogo.
      { name: 'CELLVITALIS', quantity: 1 },
    ],
  });
  assert.equal(s.serumComponents[0].code, 'P00042');
  assert.equal(s.serumComponents[0].name, 'CELLVITALIS');
  assert.equal(s.serumComponents[0].grupo, 'molecula');
  assert.equal(s.serumComponents[1].code, 'CELLVIT01');
});
