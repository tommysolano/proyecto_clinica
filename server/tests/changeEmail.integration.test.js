/**
 * CAMBIO DEL PROPIO CORREO DE ACCESO.
 *
 * El correo ES el usuario con el que se entra al sistema, así que este cambio
 * tiene que resistir tres cosas que lo convertirían en una forma de perder o
 * robar una cuenta:
 *  1. Que lo haga cualquiera desde una sesión abierta sin saber la contraseña
 *     (un ordenador desatendido en recepción).
 *  2. Que dos usuarios acaben con el mismo correo y ninguno pueda entrar.
 *  3. Que se guarde un correo con forma inválida y el dueño se quede fuera.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const H = require('./_integrationHelpers');

const User = require('../models/User');
const auth = require('../controllers/authController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId } = await H.seedClinic();
  const password = await bcrypt.hash('secreto123', 12);
  const user = await User.create({
    name: 'Jorge', email: 'jorge@correo.com', password,
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  return { clinicId, user };
}

const pedir = (clinicId, userId, body) =>
  H.runController(auth.changeEmail, H.mockReq(clinicId, userId, body, { role: 'doctor' }));

test('con la contraseña correcta, el correo cambia', async () => {
  const { clinicId, user } = await seed();

  const r = await pedir(clinicId, user._id, {
    email: '  JORGE.NUEVO@Correo.com  ',
    currentPassword: 'secreto123',
  });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardado = await User.findById(user._id).lean();
  // Normalizado: si se guardara con mayúsculas, el login (que busca en
  // minúsculas) no lo encontraría y el usuario se quedaría fuera.
  assert.equal(guardado.email, 'jorge.nuevo@correo.com');
});

test('sin la contraseña actual no se cambia nada', async () => {
  const { clinicId, user } = await seed();

  const r = await pedir(clinicId, user._id, {
    email: 'otro@correo.com',
    currentPassword: 'la-que-sea',
  });
  assert.equal(r.statusCode, 400);

  const guardado = await User.findById(user._id).lean();
  assert.equal(guardado.email, 'jorge@correo.com', 'sigue el de siempre');
});

test('no se puede tomar el correo de otro usuario', async () => {
  const { clinicId, user } = await seed();
  await User.create({
    name: 'Ana', email: 'ana@correo.com', password: await bcrypt.hash('otra', 12),
    clinics: [{ clinic: clinicId, role: 'cajero' }],
  });

  const r = await pedir(clinicId, user._id, {
    email: 'ANA@correo.com',
    currentPassword: 'secreto123',
  });
  assert.equal(r.statusCode, 409, 'dos personas no pueden entrar con el mismo correo');

  const guardado = await User.findById(user._id).lean();
  assert.equal(guardado.email, 'jorge@correo.com');
});

test('un correo con forma inválida se rechaza', async () => {
  const { clinicId, user } = await seed();
  for (const email of ['sin-arroba', 'a@b', 'a@b.c', '']) {
    const r = await pedir(clinicId, user._id, { email, currentPassword: 'secreto123' });
    assert.equal(r.statusCode, 400, `debería rechazar "${email}"`);
  }
  const guardado = await User.findById(user._id).lean();
  assert.equal(guardado.email, 'jorge@correo.com');
});

test('poner el mismo correo que ya se tiene avisa en vez de guardar', async () => {
  const { clinicId, user } = await seed();
  const r = await pedir(clinicId, user._id, {
    email: 'Jorge@Correo.com',
    currentPassword: 'secreto123',
  });
  assert.equal(r.statusCode, 400);
});
