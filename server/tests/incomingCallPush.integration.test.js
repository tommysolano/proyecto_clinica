const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const User = require('../models/User');
const { usuariosParaLlamada } = require('../utils/pushNotifications');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const makeUser = (clinic, name, role, extra = {}) => User.create({
  name,
  email: `${name.toLowerCase()}@example.com`,
  password: 'secreto1',
  clinics: [{ clinic, role }],
  ...extra,
});

const asSet = async (conversation) => new Set(await usuariosParaLlamada(conversation));

test('la llamada push solo incluye call center, marketing y super-admin activos', async () => {
  const clinic = new H.mongoose.Types.ObjectId();
  const agent = await makeUser(clinic, 'Agente', 'call_center');
  const marketing = await makeUser(clinic, 'Marketing', 'marketing');
  const superadmin = await makeUser(clinic, 'Dueno', 'admin', { isSuperAdmin: true });
  const admin = await makeUser(clinic, 'Admin', 'admin');
  const doctor = await makeUser(clinic, 'Doctor', 'doctor');
  const inactive = await makeUser(clinic, 'Inactivo', 'call_center', { active: false });

  const ids = await asSet({ _id: new H.mongoose.Types.ObjectId() });

  assert.deepEqual(ids, new Set([String(agent._id), String(marketing._id), String(superadmin._id)]));
  assert.equal(ids.has(String(admin._id)), false);
  assert.equal(ids.has(String(doctor._id)), false);
  assert.equal(ids.has(String(inactive._id)), false);
});

test('un workflow privado avisa solo al asesor responsable y a supervisores permitidos', async () => {
  const clinic = new H.mongoose.Types.ObjectId();
  const owner = await makeUser(clinic, 'Responsable', 'call_center');
  const other = await makeUser(clinic, 'Otro', 'call_center');
  const marketing = await makeUser(clinic, 'Marketing', 'marketing');
  const superadmin = await makeUser(clinic, 'Dueno', 'admin', { isSuperAdmin: true });

  const ids = await asSet({
    _id: new H.mongoose.Types.ObjectId(),
    workflowRestrictedTo: owner._id,
    workflowRestrictionActive: true,
  });

  assert.deepEqual(ids, new Set([String(owner._id), String(marketing._id), String(superadmin._id)]));
  assert.equal(ids.has(String(other._id)), false);
});

test('fuera del turno del responsable avisa a los otros asesores', async () => {
  const clinic = new H.mongoose.Types.ObjectId();
  const owner = await makeUser(clinic, 'Responsable', 'call_center');
  const other = await makeUser(clinic, 'Otro', 'call_center');
  const marketing = await makeUser(clinic, 'Marketing', 'marketing');

  const ids = await asSet({
    _id: new H.mongoose.Types.ObjectId(),
    workflowRestrictedTo: owner._id,
    workflowRestrictionActive: false,
  });

  assert.deepEqual(ids, new Set([String(marketing._id), String(other._id)]));
  assert.equal(ids.has(String(owner._id)), false);
});
