/**
 * Facturación: la lista de facturas pagina y filtra por caja (punto de emisión),
 * por número/cliente y por fechas de día completo (nov-2026).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const invoices = require('../controllers/invoiceController');
const Invoice = require('../models/Invoice');
const PuntoEmision = require('../models/PuntoEmision');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => {
  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  return r.payload;
};
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const caja1 = new mongoose.Types.ObjectId();
  const caja2 = new mongoose.Types.ObjectId();
  await PuntoEmision.collection.insertMany([
    { _id: caja1, clinic: clinicId, establecimiento: '001', codigo: '001', nombre: 'Caja 1' },
    { _id: caja2, clinic: clinicId, establecimiento: '001', codigo: '002', nombre: 'Caja 2' },
  ]);
  const hoy = new Date();
  hoy.setHours(18, 0, 0, 0); // tarde: la que quedaba fuera al leer la fecha en UTC
  const docs = [];
  for (let i = 1; i <= 7; i += 1) {
    docs.push({
      clinic: clinicId, estab: '001', ptoEmi: i <= 4 ? '001' : '002', secuencial: String(3340 + i),
      puntoEmision: i <= 4 ? caja1 : (i === 7 ? null : caja2), // la 7: antigua, sin enlace al punto
      estado: i === 3 ? 'ANULADA' : 'AUTORIZADO', importeTotal: 10,
      razonSocialComprador: i === 2 ? 'María Pérez' : 'Consumidor Final',
      identificacionComprador: i === 2 ? '0912345678' : '9999999999999',
      fechaEmision: '05/11/2026', claveAcceso: `c${i}`, createdAt: new Date(hoy.getTime() + i * 1000),
    });
  }
  await Invoice.collection.insertMany(docs);
  return { clinicId, userId, caja1, caja2, hoy };
}

const listar = (clinicId, userId, query) => H.runController(invoices.list, H.mockReq(clinicId, userId, {}, { query })).then(ok);

test('pagina y suma lo facturado del filtro (sin anuladas)', async () => {
  const { clinicId, userId } = await seed();
  const p1 = await listar(clinicId, userId, { limit: '3', page: '1' });
  assert.deepEqual(p1.pagination, { page: 1, limit: 3, total: 7, pages: 3 });
  assert.equal(p1.invoices.length, 3);
  assert.equal(p1.invoices[0].secuencial, '3347', 'la más reciente primero');
  const p3 = await listar(clinicId, userId, { limit: '3', page: '3' });
  assert.equal(p3.invoices.length, 1);
  assert.equal(p1.sumTotal, 60, '7 facturas de $10 menos la anulada');
});

test('filtra por caja, incluidas las antiguas sin enlace al punto', async () => {
  const { clinicId, userId, caja1, caja2 } = await seed();
  const c1 = await listar(clinicId, userId, { puntoEmision: String(caja1) });
  assert.equal(c1.total, 4);
  const c2 = await listar(clinicId, userId, { puntoEmision: String(caja2) });
  assert.deepEqual(c2.invoices.map((i) => i.secuencial).sort(), ['3345', '3346', '3347']);
});

test('busca por número, secuencial, cliente o cédula', async () => {
  const { clinicId, userId } = await seed();
  await Invoice.collection.updateOne({ clinic: clinicId, secuencial: '3341' }, { $set: { identificacionComprador: '0912334400' } });
  assert.equal((await listar(clinicId, userId, { q: '001-002-000003346' })).total, 1);
  assert.equal((await listar(clinicId, userId, { q: '3344' })).invoices[0].secuencial, '3344');
  assert.equal((await listar(clinicId, userId, { q: '3344' })).total, 1, 'no confunde el secuencial con parte de una cédula');
  assert.equal((await listar(clinicId, userId, { q: 'maria perez' })).total, 1);
  assert.equal((await listar(clinicId, userId, { q: '0912345678' })).total, 1);
  assert.equal((await listar(clinicId, userId, { q: 'nadie asi' })).total, 0);
});

test('las fechas son días completos y funcionan por separado', async () => {
  const { clinicId, userId, hoy } = await seed();
  const manana = new Date(hoy.getTime() + 86400000);
  assert.equal((await listar(clinicId, userId, { startDate: ymd(hoy), endDate: ymd(hoy) })).total, 7, 'el día de hoy completo');
  assert.equal((await listar(clinicId, userId, { endDate: ymd(hoy) })).total, 7);
  assert.equal((await listar(clinicId, userId, { startDate: ymd(manana) })).total, 0);
});
