/**
 * CONFIGURACIÓN DE ADMINISTRADOR: personal por sucursal y espacios de la agenda.
 *
 * 1. PERSONAL POR SUCURSAL. En qué sede trabaja cada médico, cajero y enfermero.
 *    De esto dependen los avisos: cuando una cita necesita enfermería, el aviso
 *    sale a los enfermeros DE ESA sucursal (`notificarRol` filtra por
 *    `clinics: {$elemMatch:{clinic, role}}`). Si alguien está asignado a tres
 *    sedes le suenan las tres.
 *
 * 2. ESPACIOS DE LA AGENDA. Con 20 minutos una cita solo empieza a las 14:00,
 *    14:20, 14:40… Se valida EN EL SERVIDOR porque agendan tres sitios: la
 *    página de Citas, el chat del call center y la reserva pública.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const User = require('../models/User');
const userCtrl = require('../controllers/userController');
const { isValidSlotTime, slotTimesOfDay } = require('../utils/appointmentDate');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const norte = await Clinic.create({ name: 'Shiluv Norte' });
  const sur = await Clinic.create({ name: 'Shiluv Sur' });
  const ajena = await Clinic.create({ name: 'Otra empresa' });

  const admin = await User.create({
    name: 'Admin Norte y Sur', email: 'admin@t.com', password: 'secreto123',
    clinics: [{ clinic: norte._id, role: 'admin' }, { clinic: sur._id, role: 'admin' }],
  });
  const enfermero = await User.create({
    name: 'Karla', email: 'karla@t.com', password: 'secreto123',
    clinics: [{ clinic: norte._id, role: 'enfermero' }, { clinic: sur._id, role: 'enfermero' }],
  });
  const doctora = await User.create({
    name: 'Dra. Salas', email: 'doc@t.com', password: 'secreto123',
    clinics: [{ clinic: norte._id, role: 'doctor' }, { clinic: ajena._id, role: 'doctor' }],
  });
  return { norte, sur, ajena, admin, enfermero, doctora };
}

// `req.user` es el documento completo (así lo deja el middleware `auth`).
const comoAdmin = (clinicId, admin, body = {}, params = {}) => {
  const req = H.mockReq(clinicId, admin._id, body, { role: 'admin', params });
  req.user = admin;
  return req;
};

// ───────────────────── personal por sucursal ─────────────────────

test('el admin ve solo las sucursales que administra, con su personal', async () => {
  const { norte, sur, ajena, admin, enfermero } = await seed();
  const r = await H.runController(userCtrl.getStaffAssignments, comoAdmin(norte._id, admin));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const sedes = r.payload.clinics.map((c) => c.name).sort();
  assert.deepEqual(sedes, ['Shiluv Norte', 'Shiluv Sur'], 'las dos que administra, no la ajena');
  assert.ok(!sedes.includes('Otra empresa'));

  const nombres = r.payload.users.map((u) => u.name);
  assert.ok(nombres.includes('Karla'), 'sale el enfermero');
  assert.ok(nombres.includes('Dra. Salas'), 'y la doctora, que está en Norte');
  // La rejilla de la agenda viaja con cada sucursal (la otra pestaña la usa).
  assert.ok('appointmentSlotMinutes' in r.payload.clinics[0]);
  void ajena; void enfermero;
});

test('mover a un enfermero de sucursal deja de mandarle los avisos de la otra', async () => {
  const { norte, sur, admin, enfermero } = await seed();
  // Karla estaba en las dos; se queda solo en Norte.
  const r = await H.runController(
    userCtrl.updateStaffAssignments,
    comoAdmin(norte._id, admin, { assignments: [{ clinic: norte._id, role: 'enfermero' }] },
      { id: String(enfermero._id) }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const k = await User.findById(enfermero._id).lean();
  assert.deepEqual(
    k.clinics.map((c) => String(c.clinic)),
    [String(norte._id)],
    'ya solo trabaja en Norte',
  );

  // Es exactamente la consulta que hace `notificarRol` para avisar a enfermería.
  const enSur = await User.find({
    clinics: { $elemMatch: { clinic: sur._id, role: 'enfermero' } },
  }).lean();
  assert.equal(enSur.length, 0, 'a Sur ya no le suena Karla');
  const enNorte = await User.find({
    clinics: { $elemMatch: { clinic: norte._id, role: 'enfermero' } },
  }).lean();
  assert.equal(enNorte.length, 1, 'y en Norte sigue');
});

test('no se puede tocar a alguien en una sucursal que no administras', async () => {
  const { norte, ajena, admin, doctora } = await seed();
  // La doctora está en Norte y en «Otra empresa». El admin solo gestiona Norte y
  // Sur: al guardar debe conservarse intacta su asignación en la ajena.
  await H.runController(
    userCtrl.updateStaffAssignments,
    comoAdmin(norte._id, admin, { assignments: [] }, { id: String(doctora._id) }),
  );

  const d = await User.findById(doctora._id).lean();
  assert.deepEqual(
    d.clinics.map((c) => String(c.clinic)),
    [String(ajena._id)],
    'se le quitó Norte (que sí gestiona) y se conservó la ajena',
  );
});

test('un admin no puede quitarse a sí mismo el rol de administrador', async () => {
  const { norte, sur, admin } = await seed();
  const r = await H.runController(
    userCtrl.updateStaffAssignments,
    // Intenta dejarse como cajero en Norte.
    comoAdmin(norte._id, admin, {
      assignments: [{ clinic: norte._id, role: 'cajero' }, { clinic: sur._id, role: 'admin' }],
    }, { id: String(admin._id) }),
  );
  assert.equal(r.statusCode, 400);
  assert.equal(r.payload.code, 'SELF_DEMOTION');

  const a = await User.findById(admin._id).lean();
  assert.equal(a.clinics.find((c) => String(c.clinic) === String(norte._id)).role, 'admin',
    'sigue siendo admin: si no, se quedaba fuera de la pantalla que acaba de usar');
});

test('un rol inventado no entra, y no hay dos roles en la misma sede', async () => {
  const { norte, sur, admin, enfermero } = await seed();
  await H.runController(
    userCtrl.updateStaffAssignments,
    comoAdmin(norte._id, admin, {
      assignments: [
        { clinic: norte._id, role: 'jefeSupremo' },
        { clinic: sur._id, role: 'enfermero' },
        { clinic: sur._id, role: 'cajero' },
      ],
    }, { id: String(enfermero._id) }),
  );
  const k = await User.findById(enfermero._id).lean();
  assert.equal(k.clinics.length, 1, 'una sola fila por sucursal');
  assert.equal(String(k.clinics[0].clinic), String(sur._id));
  assert.equal(k.clinics[0].role, 'cajero', 'gana la última válida de esa sede');
});

// ───────────────────── espacios de la agenda ─────────────────────

test('sin espacios configurados vale cualquier hora', async () => {
  assert.equal(isValidSlotTime('18:37', 0), true);
  assert.equal(isValidSlotTime('18:37', null), true);
  assert.equal(isValidSlotTime('18:37', undefined), true);
});

test('con espacios de 20 minutos solo valen las horas de la rejilla', async () => {
  assert.equal(isValidSlotTime('14:00', 20), true);
  assert.equal(isValidSlotTime('14:20', 20), true);
  assert.equal(isValidSlotTime('14:40', 20), true);
  assert.equal(isValidSlotTime('15:00', 20), true);
  assert.equal(isValidSlotTime('14:37', 20), false);
  assert.equal(isValidSlotTime('14:30', 20), false, '30 no cae en la rejilla de 20');
});

test('la rejilla arranca en medianoche y cuadra con la hora en punto', async () => {
  const t20 = slotTimesOfDay(20);
  assert.equal(t20[0], '00:00');
  assert.equal(t20.length, 72, '24 h / 20 min');
  assert.ok(t20.includes('14:00') && t20.includes('14:20') && t20.includes('14:40'));

  const t30 = slotTimesOfDay(30);
  assert.equal(t30.length, 48);
  assert.deepEqual(t30.slice(0, 4), ['00:00', '00:30', '01:00', '01:30']);

  assert.deepEqual(slotTimesOfDay(0), [], 'sin rejilla no hay horas que listar');
});

test('el espacio se guarda por sucursal y por defecto está apagado', async () => {
  const { norte } = await seed();
  const recien = await Clinic.findById(norte._id).lean();
  assert.equal(recien.appointmentSlotMinutes, 0, 'apagado por defecto: no cambia cómo agenda nadie');

  await Clinic.findByIdAndUpdate(norte._id, { appointmentSlotMinutes: 20 });
  const tras = await Clinic.findById(norte._id).lean();
  assert.equal(tras.appointmentSlotMinutes, 20);
});

test('el cliente y el servidor calculan la MISMA rejilla', async () => {
  // Si se separan, la pantalla ofrece una hora que el servidor rechaza con 400.
  const fs = require('fs');
  const path = require('path');
  const ruta = path.join(__dirname, '..', '..', 'client', 'src', 'utils', 'slots.js');
  const src = fs.readFileSync(ruta, 'utf8').replace(/^export /gm, '');
  // eslint-disable-next-line no-new-func
  const cli = new Function(`${src}\nreturn { slotTimesOfDay, isValidSlotTime };`)();

  for (const paso of [0, 10, 15, 20, 30, 45, 60]) {
    assert.deepEqual(cli.slotTimesOfDay(paso), slotTimesOfDay(paso), `rejilla de ${paso}`);
  }
  for (const hora of ['00:00', '14:00', '14:20', '14:30', '14:37', '23:40']) {
    for (const paso of [0, 20, 30]) {
      assert.equal(
        cli.isValidSlotTime(hora, paso), isValidSlotTime(hora, paso),
        `${hora} con paso ${paso}`,
      );
    }
  }
});
