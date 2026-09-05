/**
 * EL ADMIN CAMBIA LA CONTRASEÑA DE OTRO USUARIO Y ESA CONTRASEÑA ENTRA.
 *
 * Caso real (5-sep-2026): en «Usuarios de la sucursal» se edita a alguien, se
 * escribe una contraseña nueva, sale «Usuario actualizado»... y esa persona no
 * puede entrar con ella. La única prueba que vale es la de punta a punta: pasar
 * por `updateUser` como lo hace la pantalla y después por `login` de verdad.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
const H = require('./_integrationHelpers');

const User = require('../models/User');
const users = require('../controllers/userController');
const auth = require('../controllers/authController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId } = await H.seedClinic();
  const admin = await User.create({
    name: 'Admin', email: 'admin@correo.com',
    password: await bcrypt.hash('adminpass', 12),
    clinics: [{ clinic: clinicId, role: 'admin' }],
  });
  const empleado = await User.create({
    name: 'Enfermera Ana', email: 'ana@correo.com',
    password: await bcrypt.hash('vieja123', 12),
    clinics: [{ clinic: clinicId, role: 'enfermero' }],
  });
  return { clinicId, admin, empleado };
}

/** Exactamente lo que manda el modal de Users.jsx al guardar una edición. */
const editar = (clinicId, admin, empleado, extra) =>
  H.runController(
    users.updateUser,
    H.mockReq(clinicId, admin._id, {
      name: empleado.name,
      email: empleado.email,
      cedula: '',
      phone: '',
      specialty: '',
      clinics: [{ clinic: String(clinicId), role: 'enfermero' }],
      ...extra,
    }, { role: 'admin', params: { id: String(empleado._id) }, user: admin })
  );

const entrar = (email, password) =>
  H.runController(auth.login, H.mockReq(null, null, { email, password }));

test('la contraseña nueva que pone el admin sirve para entrar', async () => {
  const { clinicId, admin, empleado } = await seed();

  const r = await editar(clinicId, admin, empleado, { password: 'nueva123' });
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const ok = await entrar('ana@correo.com', 'nueva123');
  assert.equal(ok.statusCode < 400, true, `no pudo entrar: ${JSON.stringify(ok.payload)}`);
});

test('y la vieja deja de servir', async () => {
  const { clinicId, admin, empleado } = await seed();
  await editar(clinicId, admin, empleado, { password: 'nueva123' });

  const r = await entrar('ana@correo.com', 'vieja123');
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
});

test('editar SIN tocar la contraseña no la cambia', async () => {
  const { clinicId, admin, empleado } = await seed();

  await editar(clinicId, admin, empleado, { phone: '0999999999' });

  const ok = await entrar('ana@correo.com', 'vieja123');
  assert.equal(ok.statusCode < 400, true, `perdió su contraseña: ${JSON.stringify(ok.payload)}`);
});

/**
 * EL CASO QUE DABA LA PISTA FALSA.
 *
 * Un usuario DESACTIVADO no entra por mucho que se le cambie la contraseña, y
 * el login respondía «Credenciales inválidas» —lo mismo que si la contraseña
 * estuviera mal—. Desde el mostrador eso se lee como «el cambio no se guardó».
 */
test('a un usuario desactivado el login le dice POR QUÉ, no "credenciales inválidas"', async () => {
  const { clinicId, admin, empleado } = await seed();
  await User.updateOne({ _id: empleado._id }, { active: false });

  await editar(clinicId, admin, empleado, { password: 'nueva123', active: false });

  const r = await entrar('ana@correo.com', 'nueva123');
  assert.equal(r.statusCode, 403, JSON.stringify(r.payload));
  assert.equal(r.payload.code, 'USER_INACTIVE');
  assert.match(r.payload.message, /desactivado/i);
});

test('el motivo real solo se revela si la contraseña ES la correcta', async () => {
  const { clinicId, empleado } = await seed();
  await User.updateOne({ _id: empleado._id }, { active: false });
  assert.ok(clinicId);

  // Con la contraseña equivocada NO se puede averiguar que la cuenta existe.
  const r = await entrar('ana@correo.com', 'loquesea');
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /credenciales inválidas/i);
  assert.equal(r.payload.code, undefined);
});

test('reactivar y cambiar la contraseña en el mismo guardado deja entrar', async () => {
  const { clinicId, admin, empleado } = await seed();
  await User.updateOne({ _id: empleado._id }, { active: false });

  // Es lo que manda el modal con la casilla «Activo» marcada.
  await editar(clinicId, admin, empleado, { password: 'nueva123', active: true });

  const ok = await entrar('ana@correo.com', 'nueva123');
  assert.equal(ok.statusCode < 400, true, JSON.stringify(ok.payload));
});

test('un correo que no existe sigue sin distinguirse', async () => {
  await seed();
  const r = await entrar('nadie@correo.com', 'loquesea');
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /credenciales inválidas/i);
});
