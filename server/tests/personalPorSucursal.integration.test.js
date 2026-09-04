/**
 * PERSONAL POR SUCURSAL: mover a alguien de sede.
 *
 * De aquí sale quién aparece al asignar la atención de una cita y a quién le
 * suenan los avisos. El síntoma que trajo esta prueba: se agendaba una cita en
 * Extensión, se iba a asignar doctor y no aparecía NINGUNO — porque todo el
 * personal seguía puesto en la matriz. Con la pantalla arreglada (una sola
 * columna, «dónde trabaja»), lo que hay que garantizar es que mover a alguien:
 *
 *  1. lo QUITE de la sede anterior (si no, sigue saliendo en las dos);
 *  2. le CONSERVE el rol —la pantalla ya no lo pregunta— y
 *  3. se note de verdad en `GET /users/doctors?clinic=`, que es lo que lee el
 *     modal de asignación de la cita.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const User = require('../models/User');
const users = require('../controllers/userController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function seed() {
  // Las sucursales tienen que EXISTIR como documentos: `clinicasQueGestiona`
  // consulta la colección, y con un id suelto la sede no se gestiona (y entonces
  // el guardado la conservaría intacta en vez de repartirla).
  const { clinicId: matriz } = await H.seedClinic();
  await Clinic.create({ _id: matriz, name: 'Matriz' });
  const extension = (await Clinic.create({ name: 'Extension' }))._id;

  // El administrador gestiona las dos sedes.
  const admin = await User.create({
    name: 'Admin', email: 'admin@t.com', password: 'secreto123',
    clinics: [{ clinic: matriz, role: 'admin' }, { clinic: extension, role: 'admin' }],
  });
  // Y un doctor que hoy está en la matriz, como todos.
  const doctora = await User.create({
    name: 'Dra. Salas', email: 'doc@t.com', password: 'secreto123',
    clinics: [{ clinic: matriz, role: 'doctor' }],
  });

  return { matriz, extension, admin, doctora };
}

const doctoresDe = (admin, clinicId) =>
  H.runController(
    users.getDoctors,
    H.mockReq(clinicId, admin._id, {}, { role: 'admin', query: { clinic: String(clinicId) } }),
  );

test('mover a alguien de sede lo quita de la anterior y le conserva el rol', async () => {
  const { matriz, extension, admin, doctora } = await seed();

  const r = ok(await H.runController(
    users.updateStaffAssignments,
    (() => {
      const req = H.mockReq(null, admin._id, {
        assignments: [{ clinic: String(extension), role: 'doctor' }],
      }, { role: 'admin', params: { id: String(doctora._id) } });
      req.user.clinics = admin.clinics;
      return req;
    })(),
  ));

  assert.equal(r.clinics.length, 1, 'una persona, una sucursal');
  assert.equal(String(r.clinics[0].clinic), String(extension), 'ahora trabaja en Extensión');
  assert.equal(r.clinics[0].role, 'doctor', 'y sigue siendo doctora');

  const enBase = await User.findById(doctora._id).lean();
  assert.equal(enBase.clinics.length, 1, 'ya no está en la matriz');
  assert.equal(String(enBase.clinics[0].clinic), String(extension));
  assert.notEqual(String(enBase.clinics[0].clinic), String(matriz));
});

test('y a partir de ahí SÍ aparece al asignar la atención de una cita de esa sede', async () => {
  const { matriz, extension, admin, doctora } = await seed();

  // Antes de mover: la cita de Extensión no tiene a quién asignar. Este es el
  // síntoma exacto que reportó la clínica.
  const antesExt = ok(await doctoresDe(admin, extension));
  assert.equal(antesExt.length, 0, 'sin personal en Extensión no hay a quién asignar');
  const antesMat = ok(await doctoresDe(admin, matriz));
  assert.equal(antesMat.length, 1, 'estaba toda en la matriz');

  const req = H.mockReq(null, admin._id, {
    assignments: [{ clinic: String(extension), role: 'doctor' }],
  }, { role: 'admin', params: { id: String(doctora._id) } });
  req.user.clinics = admin.clinics;
  ok(await H.runController(users.updateStaffAssignments, req));

  const despuesExt = ok(await doctoresDe(admin, extension));
  assert.equal(despuesExt.length, 1, 'ya se le puede asignar la cita de Extensión');
  assert.equal(despuesExt[0].roleInClinic, 'doctor', 'con su especialidad, para el selector');
  const despuesMat = ok(await doctoresDe(admin, matriz));
  assert.equal(despuesMat.length, 0, 'y deja de salir en la matriz, donde ya no trabaja');
});

test('las sedes que este admin NO gestiona no se tocan', async () => {
  const { matriz, extension, admin, doctora } = await seed();
  const ajena = (await Clinic.create({ name: 'Otra empresa' }))._id;
  doctora.clinics.push({ clinic: ajena, role: 'doctor' });
  await doctora.save();

  // El admin solo gestiona matriz y extensión.
  const req = H.mockReq(null, admin._id, {
    assignments: [{ clinic: String(extension), role: 'doctor' }],
  }, { role: 'admin', params: { id: String(doctora._id) } });
  req.user.clinics = [
    { clinic: matriz, role: 'admin' },
    { clinic: extension, role: 'admin' },
  ];
  ok(await H.runController(users.updateStaffAssignments, req));

  const enBase = await User.findById(doctora._id).lean();
  const ids = enBase.clinics.map((c) => String(c.clinic)).sort();
  assert.deepEqual(
    ids,
    [String(ajena), String(extension)].sort(),
    'la sede ajena se conserva; solo se reparte lo que este admin gestiona',
  );
});
