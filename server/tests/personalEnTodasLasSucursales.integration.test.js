/**
 * «TRABAJA EN TODAS LAS SUCURSALES».
 *
 * En la clínica hay gente que no tiene sede: el mismo doctor pasa consulta en
 * Central por la mañana y en Extensión por la tarde, y el reparto cambia cada
 * semana. Con la asignación fija había que moverlo a mano cada vez — y mientras
 * no se hacía, no salía en el selector de doctores de la sede donde de verdad
 * estaba, así que la cita no se le podía asignar.
 *
 * Lo que se vigila aquí es que la marca valga EN LOS DOS SITIOS que responden a
 * «¿trabaja aquí?»: la consulta de mongo (los selectores, los avisos) y
 * `getRoleForClinic` (entrar a la sede, que es lo que hace falta para abrir la
 * cita). Si solo valiera en uno, el doctor saldría en el desplegable y luego
 * recibiría un «No tienes acceso a esta clínica» — o al revés.
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
  const { clinicId: central, userId } = await H.seedClinic();
  await Clinic.create({ _id: central, name: 'Central' });
  const extension = (await Clinic.create({ name: 'Extension' }))._id;

  const crear = (name, role, clinic, extras = {}) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic, role }], ...extras,
    });

  const fijo = await crear('Fijo', 'doctor', central);
  const rotativo = await crear('Rotativo', 'doctor', central, { worksInAllClinics: true });
  const enfRotativa = await crear('EnfRota', 'enfermero', central, { worksInAllClinics: true });
  return { central, extension, userId, fijo, rotativo, enfRotativa };
}

const doctoresDe = (clinicId, userId, sede) =>
  H.runController(users.getDoctors, H.mockReq(clinicId, userId, {}, { role: 'cajero', query: { clinic: String(sede) } }));

test('T1) el doctor marcado sale en el selector de OTRA sucursal; el fijo no', async () => {
  const { central, extension, userId, fijo, rotativo } = await seed();

  const enCentral = ok(await doctoresDe(central, userId, central)).map((d) => d.name).sort();
  assert.deepEqual(enCentral, ['Fijo', 'Rotativo'], 'en su sede están los dos');

  const enExtension = ok(await doctoresDe(central, userId, extension)).map((d) => d.name);
  assert.deepEqual(enExtension, ['Rotativo'], 'en la otra, solo quien rota');
  assert.ok(!enExtension.includes('Fijo'), String(fijo._id) && 'el fijo sigue siendo de su sede');
});

test('T2) y llega con su rol, que es de donde sale la especialidad', async () => {
  const { central, extension, userId } = await seed();
  const [rotativo] = ok(await doctoresDe(central, userId, extension));
  // Sin esto la pantalla no sabe si es medicina general, ginecología u óptica:
  // ese rol no viene de una fila para ESTA sede, porque no la tiene.
  assert.equal(rotativo.roleInClinic, 'doctor');
});

test('T3) también en el selector de enfermería', async () => {
  const { central, extension, userId } = await seed();
  const r = ok(await H.runController(
    users.getNurses,
    H.mockReq(central, userId, {}, { role: 'cajero', query: { clinic: String(extension) } }),
  ));
  assert.deepEqual(r.map((n) => n.name), ['EnfRota']);
});

/**
 * La otra mitad: PODER ENTRAR. Salir en el desplegable y que al abrir la cita le
 * respondan «No tienes acceso a esta clínica» sería peor que no salir.
 */
test('T4) getRoleForClinic le da su rol en cualquier sucursal', async () => {
  const { central, extension, fijo, rotativo } = await seed();

  assert.equal(rotativo.getRoleForClinic(central), 'doctor');
  assert.equal(rotativo.getRoleForClinic(extension), 'doctor', 'entra a la sede donde le pusieron la cita');
  assert.equal(fijo.getRoleForClinic(extension), null, 'el fijo, no');
  assert.equal(rotativo.getRoleForClinic(null), null);
});

test('T5) los avisos de enfermería también le llegan en la otra sede', async () => {
  const { central, extension } = await seed();
  // Es exactamente la consulta que hace `notificarRol` para avisar a enfermería.
  const enExtension = await User.find({
    ...User.enSucursal(extension, 'enfermero'),
    active: { $ne: false },
  }).lean();
  assert.deepEqual(enExtension.map((u) => u.name), ['EnfRota']);

  // Y el filtro sigue siendo estricto con el rol: un doctor que rota no es
  // enfermero en ninguna sede.
  const doctores = await User.find(User.enSucursal(central, 'enfermero')).lean();
  assert.deepEqual(doctores.map((u) => u.name), ['EnfRota']);
});

// ─────────────────── Guardar la marca ───────────────────

/**
 * Quien guarda tiene que ADMINISTRAR la sede: `clinicasQueGestiona` sale de
 * `req.user.clinics`, y sin ella la sucursal no es "gestionable" — el servidor
 * conserva la asignación intacta y no llega a evaluarse nada.
 */
const guardar = (clinicId, userId, targetId, body) => {
  const req = H.mockReq(clinicId, userId, body, { role: 'admin', params: { id: String(targetId) } });
  req.user.clinics = [{ clinic: clinicId, role: 'admin' }];
  return H.runController(users.updateStaffAssignments, req);
};

test('T6) se marca y se desmarca desde Configuración → Personal', async () => {
  const { central, userId, fijo } = await seed();
  const req = { assignments: [{ clinic: String(central), role: 'doctor' }] };

  ok(await guardar(central, userId, fijo._id, { ...req, worksInAllClinics: true }));
  assert.equal((await User.findById(fijo._id)).worksInAllClinics, true);

  ok(await guardar(central, userId, fijo._id, { ...req, worksInAllClinics: false }));
  assert.equal((await User.findById(fijo._id)).worksInAllClinics, false);
});

/**
 * Sin sucursal no hay rol que extender: la persona quedaría marcada como «en
 * todas» y sin ser nada en ninguna, que es exactamente el estado en el que
 * desaparece de todas las pantallas.
 */
test('T7) no se puede marcar «en todas» a quien no tiene sucursal', async () => {
  const { central, userId, fijo } = await seed();
  const r = await guardar(central, userId, fijo._id, { assignments: [], worksInAllClinics: true });
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.equal(r.payload.code, 'ALL_CLINICS_WITHOUT_ROLE');
  assert.equal((await User.findById(fijo._id)).worksInAllClinics, false, 'no se guardó a medias');
});

test('T8) guardar sin mencionar la marca no la toca', async () => {
  const { central, userId, rotativo } = await seed();
  ok(await guardar(central, userId, rotativo._id, {
    assignments: [{ clinic: String(central), role: 'doctor' }],
  }));
  assert.equal((await User.findById(rotativo._id)).worksInAllClinics, true, 'sigue marcado');
});
