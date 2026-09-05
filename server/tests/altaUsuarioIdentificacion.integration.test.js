/**
 * EL ALTA DE PERSONAL ACEPTA CUALQUIER CÉDULA Y CUALQUIER CORREO.
 *
 * Reclamo real (5-sep-2026): al crear un usuario, una cédula correcta salía
 * marcada como incorrecta y el correo también. El bloqueo era del CLIENTE —el
 * aviso rojo del SRI y el `type="email"`, que hace que se plante el navegador—,
 * no del servidor, que nunca ha validado ninguno de los dos.
 *
 * Esta prueba fija esa parte del contrato: el servidor no puede empezar a
 * exigirlos, porque el personal de la clínica lleva pasaportes, cédulas
 * extranjeras y alguna que el dígito verificador rechaza. Lo que valida el SRI
 * es el RUC de un COMPROBANTE, que es otra cosa.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const User = require('../models/User');
require('../models/Clinic'); // el alta hace populate de clinics.clinic
const users = require('../controllers/userController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const alta = async (clinicId, adminId, body) =>
  H.runController(
    users.createUser,
    H.mockReq(clinicId, adminId, { name: 'Alguien', password: 'secreto123', role: 'enfermero', ...body },
      { role: 'admin', user: { _id: adminId, isSuperAdmin: false } })
  );

test('se da de alta con una cédula que el SRI no valida', async () => {
  const { clinicId, userId } = await H.seedClinic();

  // Dígito verificador incorrecto a propósito: es lo que el SRI rechaza.
  const r = await alta(clinicId, userId, { email: 'nuevo@correo.com', cedula: '1234567890' });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal((await User.findOne({ email: 'nuevo@correo.com' })).cedula, '1234567890');
});

test('un pasaporte alfanumérico también entra', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await alta(clinicId, userId, { email: 'pasaporte@correo.com', cedula: 'AB1234567' });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal((await User.findOne({ email: 'pasaporte@correo.com' })).cedula, 'AB1234567');
});

test('el correo se guarda tal cual, sin exigirle formato ni dominio con MX', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await alta(clinicId, userId, { email: 'recepcion@clinicainterna', cedula: '' });
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  // El esquema solo normaliza a minúsculas y recorta: no valida la forma.
  assert.ok(await User.findOne({ email: 'recepcion@clinicainterna' }));
});

test('lo único que sigue siendo obligatorio son los campos del alta', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const r = await H.runController(
    users.createUser,
    H.mockReq(clinicId, userId, { name: 'Sin correo', password: 'secreto123', role: 'enfermero' },
      { role: 'admin', user: { _id: userId, isSuperAdmin: false } })
  );
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /faltan campos/i);
});
