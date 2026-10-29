/**
 * La sesión NO caduca: dura hasta que el usuario cierra sesión.
 *
 *  - El login emite tokens sin `exp`.
 *  - Los tokens viejos (emitidos con caducidad de 7 días) siguen valiendo aunque
 *    ya hayan pasado esos días.
 *  - Un token falso sigue siendo 401 (eso sí cierra la sesión).
 *  - Un fallo del SERVIDOR al comprobar la sesión es 503, no 401: el frontend
 *    cierra la sesión ante cualquier 401, y un tropiezo de la base de datos
 *    echaba a la gente.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'secreto-de-prueba';
const H = require('./_integrationHelpers');

const User = require('../models/User');
const userCache = require('../utils/userCache');
const { auth } = require('../middleware/auth');
const authCtrl = require('../controllers/authController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); userCache.invalidateAll(); });

async function seedUser() {
  return User.create({
    name: 'Recepción',
    email: 'recepcion@test.com',
    password: await bcrypt.hash('secreta123', 10),
    active: true,
  });
}

async function runAuth(token) {
  const req = H.mockReq(null, null, {}, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  req.header = (name) => req.get(name);
  const { res, state } = (() => {
    const s = { statusCode: 200, payload: undefined, done: false };
    const r = {
      status: (c) => { s.statusCode = c; return r; },
      json: (p) => { s.payload = p; s.done = true; return r; },
    };
    return { res: r, state: s };
  })();
  let passed = false;
  await auth(req, res, () => { passed = true; });
  return { passed, state, req };
}

test('el login emite un token SIN caducidad', async () => {
  await seedUser();
  const state = await H.runController(authCtrl.login, H.mockReq(null, null, { email: 'recepcion@test.com', password: 'secreta123' }));
  assert.equal(state.statusCode, 200, JSON.stringify(state.payload));
  const decoded = jwt.decode(state.payload.token);
  assert.ok(decoded.id);
  assert.equal(decoded.exp, undefined, 'el token no debe llevar exp');
});

test('un token emitido con caducidad de 7 días sigue valiendo pasados esos días', async () => {
  const user = await seedUser();
  const hace8dias = Math.floor(Date.now() / 1000) - 8 * 86400;
  const viejo = jwt.sign({ id: user._id, iat: hace8dias, exp: hace8dias + 7 * 86400 }, process.env.JWT_SECRET);
  const { passed, req } = await runAuth(viejo);
  assert.equal(passed, true);
  assert.equal(String(req.user._id), String(user._id));
});

test('token falso o ausente: 401', async () => {
  await seedUser();
  const falso = jwt.sign({ id: 'x' }, 'otro-secreto');
  assert.equal((await runAuth(falso)).state.statusCode, 401);
  assert.equal((await runAuth(null)).state.statusCode, 401);
});

test('usuario desactivado: 401 (desactivar sigue cortando el acceso)', async () => {
  const user = await seedUser();
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
  await User.updateOne({ _id: user._id }, { active: false });
  userCache.invalidateAll();
  assert.equal((await runAuth(token)).state.statusCode, 401);
});

test('fallo del servidor al comprobar la sesión: 503 AUTH_UNAVAILABLE, no 401', async () => {
  const user = await seedUser();
  const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET);
  const original = User.findById;
  User.findById = () => { throw new Error('Atlas no responde'); };
  try {
    const { passed, state } = await runAuth(token);
    assert.equal(passed, false);
    assert.equal(state.statusCode, 503);
    assert.equal(state.payload.code, 'AUTH_UNAVAILABLE');
  } finally {
    User.findById = original;
  }
});
