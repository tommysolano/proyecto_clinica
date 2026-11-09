/**
 * Quién ve qué cajas en Caja (Apertura/Cierre) (nov-2026): cajero y admin, solo las suyas;
 * el super administrador, contabilidad y marketing (solo lectura), todas las de la empresa.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const CashClosing = require('../models/CashClosing');
const User = require('../models/User');
const Clinic = require('../models/Clinic');
const cashClosing = require('../controllers/cashClosingController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

let n = 0;
const usuario = (clinicId, role, extra = {}) => {
  n += 1;
  return User.create({ name: `${role} ${n}`, email: `vis${n}-${Date.now()}@t.com`, password: 'secreto123', clinics: [{ clinic: clinicId, role }], ...extra });
};
const como = (clinicId, user, role, extra = {}) => Object.assign(
  H.mockReq(clinicId, user._id, {}, { role, ...extra }),
  { user },
);

async function seed() {
  const { clinicId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Extensión' });
  const admin = await usuario(clinicId, 'admin');
  const cajera = await usuario(clinicId, 'cajero');
  const conta = await usuario(clinicId, 'contabilidad');
  const sa = await usuario(clinicId, 'admin', { isSuperAdmin: true });
  const caja = (u) => CashClosing.create({ clinic: clinicId, date: new Date(), openedAt: new Date(), openedBy: u._id, status: 'ABIERTA' });
  const deAdmin = await caja(admin);
  const deCajera = await caja(cajera);
  return { clinicId, admin, cajera, conta, sa, deAdmin, deCajera };
}

test('el admin ve solo sus cajas; contabilidad y super admin ven todas', async () => {
  const { clinicId, admin, cajera, conta, sa, deAdmin, deCajera } = await seed();
  const ids = async (u, role) => (await H.runController(cashClosing.list, como(clinicId, u, role, { query: { clinic: 'all' } }))).payload.map((c) => String(c._id)).sort();

  assert.deepEqual(await ids(admin, 'admin'), [String(deAdmin._id)]);
  assert.deepEqual(await ids(cajera, 'cajero'), [String(deCajera._id)]);
  assert.deepEqual(await ids(conta, 'contabilidad'), [String(deAdmin._id), String(deCajera._id)].sort());
  assert.deepEqual(await ids(sa, 'admin'), [String(deAdmin._id), String(deCajera._id)].sort());

  // Detalle de la caja de otra persona: el admin no; el super admin sí.
  const verDetalle = (u, role) => H.runController(cashClosing.detail, como(clinicId, u, role, { params: { id: String(deCajera._id) }, query: {} }));
  assert.equal((await verDetalle(admin, 'admin')).statusCode, 403);
  assert.equal((await verDetalle(sa, 'admin')).statusCode, 200);

  // El filtro de sucursales («todas») es solo del super admin.
  const branches = async (u, role) => (await H.runController(cashClosing.branches, como(clinicId, u, role))).payload.canSeeAll;
  assert.equal(await branches(admin, 'admin'), false);
  assert.equal(await branches(sa, 'admin'), true);
});

test('contabilidad y marketing ven las cajas de todas las sucursales de la empresa y las suman', async () => {
  const { invalidateCompanyCache, ensureCompanyCache } = require('../utils/companies');
  const mongoose = H.mongoose;
  const company = new mongoose.Types.ObjectId();
  const { clinicId, conta, cajera, deAdmin, deCajera } = await seed();
  await Clinic.updateOne({ _id: clinicId }, { $set: { company } });
  const otraId = new mongoose.Types.ObjectId();
  await Clinic.create({ _id: otraId, name: 'Laboratorio', company });
  const marketing = await usuario(clinicId, 'marketing');
  const deOtra = await CashClosing.create({ clinic: otraId, date: new Date(), openedAt: new Date(), openedBy: cajera._id, status: 'ABIERTA' });
  invalidateCompanyCache();
  await ensureCompanyCache();

  try {
    for (const [u, role] of [[conta, 'contabilidad'], [marketing, 'marketing']]) {
      const req = (extra) => Object.assign(como(clinicId, u, role, extra), { companyId: String(company) });
      const lista = await H.runController(cashClosing.list, req({ query: { clinic: 'all' } }));
      assert.deepEqual(lista.payload.map((c) => String(c._id)).sort(), [deAdmin, deCajera, deOtra].map((c) => String(c._id)).sort(), role);
      const suma = await H.runController(cashClosing.detail, req({ params: { id: String(deCajera._id) }, query: { add: String(deOtra._id) } }));
      assert.equal(suma.statusCode, 200, role);
      assert.equal(suma.payload.closings.length, 2, role);
      assert.equal((await H.runController(cashClosing.branches, req({}))).payload.canSeeAll, true, role);
    }
  } finally {
    invalidateCompanyCache();
  }
});

test('marketing solo puede leer: las rutas de operar la caja lo rechazan', () => {
  const router = require('../routes/cashClosings');
  const guardia = (metodo, ruta) => {
    const capa = router.stack.find((l) => l.route?.path === ruta && l.route.methods[metodo]);
    return capa.route.stack[0].handle;
  };
  const responde = (metodo, ruta) => {
    let codigo = null;
    guardia(metodo, ruta)(
      { user: { _id: 'x' }, role: 'marketing' },
      { status(c) { codigo = c; return this; }, json() { return this; } },
      () => { codigo = 'pasa'; },
    );
    return codigo;
  };
  for (const [m, r] of [['get', '/branches'], ['get', '/'], ['get', '/:id/detail']]) assert.equal(responde(m, r), 'pasa', r);
  for (const [m, r] of [
    ['get', '/current'], ['get', '/summary'], ['get', '/movements'], ['post', '/movements'], ['post', '/movements/:id/void'],
    ['post', '/open'], ['post', '/:id/close'], ['post', '/'], ['post', '/:id/cancel'],
  ]) assert.equal(responde(m, r), 403, r);
});
