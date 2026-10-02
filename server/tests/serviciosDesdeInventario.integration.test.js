/**
 * LOS SERVICIOS DE LA AGENDA SALEN DEL INVENTARIO (oct-2026).
 *
 * Al agendar (y al derivar) ya no se escribe el servicio: se escoge de los
 * productos de tipo SERVICIO del inventario. La cita sigue guardando su
 * `AppointmentServiceItem`, que `utils/serviciosInventario.js` mantiene
 * enlazado con su producto. Lo que vigilan estos tests:
 *
 *  1. Que se ofrezcan los servicios del inventario, y solo esos.
 *  2. Que el servicio de la agenda que ya existía con ese nombre se ENLACE (con
 *     su duración y su historia) en vez de quedar dos.
 *  3. Que lo que sale del inventario deje de ofrecerse sin borrarse.
 *  4. Que no se pueda renombrar desde la agenda algo cuyo nombre manda el
 *     inventario.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const Product = require('../models/Product');
const ctrl = require('../controllers/appointmentServiceItemController');
const { sincronizarServiciosInventario, marcarServiciosPendientes } = require('../utils/serviciosInventario');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); marcarServiciosPendientes(); });

const servicio = (clinicId, name, extra = {}) =>
  H.makeProduct(clinicId, { name, category: 'servicio', unlimited: true, ...extra });

const listar = (clinicId, userId, query = {}) =>
  H.runController(ctrl.list, H.mockReq(clinicId, userId, {}, { role: 'cajero', query }));

test('se ofrecen los SERVICIOS del inventario, y no los insumos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await servicio(clinicId, 'ECO GLANDULAS MAMARIAS');
  await servicio(clinicId, 'ANTICUERPOS IgA ANTI MYCOPLASMA PNEUMONIAE EN SUERO');
  await H.makeProduct(clinicId, { name: 'Jeringa 5 ml', category: 'insumo' });
  await servicio(clinicId, 'Servicio retirado', { active: false });

  const r = await listar(clinicId, userId);
  const nombres = r.payload.map((i) => i.name).sort();
  assert.deepEqual(nombres, ['ANTICUERPOS IgA ANTI MYCOPLASMA PNEUMONIAE EN SUERO', 'ECO GLANDULAS MAMARIAS']);
  assert.ok(r.payload.every((i) => i.product), 'cada uno enlazado a su producto');
});

test('lo escrito a mano en el catálogo viejo ya no se ofrece, pero sigue para leer citas', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await AppointmentServiceItem.create({ name: 'Inventado al vuelo', slug: 'inventado al vuelo' });

  const ofrecidos = await listar(clinicId, userId);
  assert.equal(ofrecidos.payload.length, 0, 'no sale al agendar');

  const todos = await listar(clinicId, userId, { all: 1 });
  assert.equal(todos.payload.length, 1, 'con `all` sigue: las citas viejas lo usan');
});

test('el servicio de agenda con el mismo nombre se ENLAZA, con su duración y su id', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const viejo = await AppointmentServiceItem.create({
    name: 'Ecocardiograma', slug: 'ecocardiograma', durationMinutes: 40, usageCount: 12,
  });
  const p = await servicio(clinicId, 'ECOCARDIOGRAMA');

  const r = await listar(clinicId, userId);
  assert.equal(r.payload.length, 1, 'uno, no dos');
  const it = r.payload[0];
  assert.equal(String(it._id), String(viejo._id), 'el mismo registro: las citas y comisiones siguen apuntando a él');
  assert.equal(String(it.product), String(p._id));
  assert.equal(it.name, 'ECOCARDIOGRAMA', 'con el nombre del inventario');
  assert.equal(it.durationMinutes, 40, 'la duración configurada no se pierde');
});

test('dos productos que se llaman igual son UNA opción', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await servicio(clinicId, 'Consulta Cardiología');
  await servicio(clinicId, 'CONSULTA CARDIOLOGIA');

  const r = await listar(clinicId, userId);
  assert.equal(r.payload.length, 1);
});

test('un producto desactivado deja de ofrecerse, pero su servicio no se borra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await servicio(clinicId, 'Ozonoterapia');
  await sincronizarServiciosInventario({ force: true });
  const item = await AppointmentServiceItem.findOne({ product: p._id }).lean();
  assert.ok(item);

  await Product.updateOne({ _id: p._id }, { active: false });
  marcarServiciosPendientes();

  const r = await listar(clinicId, userId);
  assert.equal(r.payload.length, 0, 'ya no se ofrece');
  const sigue = await AppointmentServiceItem.findById(item._id).lean();
  assert.ok(sigue, 'las citas que lo usan conservan su servicio');
  assert.equal(sigue.product, null, 'solo se desengancha');
});

test('sincronizar dos veces no duplica nada', async () => {
  const { clinicId } = await H.seedClinic();
  await servicio(clinicId, 'Plasma');
  await servicio(clinicId, 'Sueroterapia');
  await sincronizarServiciosInventario({ force: true });
  const segunda = await sincronizarServiciosInventario({ force: true });
  assert.equal(segunda.cambios, 0);
  assert.equal(await AppointmentServiceItem.countDocuments(), 2);
});

test('el nombre de un servicio del inventario no se cambia desde la agenda', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await servicio(clinicId, 'Biorresonancia');
  await sincronizarServiciosInventario({ force: true });
  const item = await AppointmentServiceItem.findOne({ product: p._id });

  const r = await H.runController(
    ctrl.update,
    H.mockReq(clinicId, userId, { name: 'Bio' }, { role: 'admin', params: { id: String(item._id) } }),
  );
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /inventario/i);

  // La duración sí: eso es de la agenda.
  const ok = await H.runController(
    ctrl.update,
    H.mockReq(clinicId, userId, { durationMinutes: 30 }, { role: 'admin', params: { id: String(item._id) } }),
  );
  assert.equal(ok.statusCode < 400, true);
});
