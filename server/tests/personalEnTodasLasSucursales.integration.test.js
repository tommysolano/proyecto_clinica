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

// ─────────────────── La agenda de quien rota ───────────────────

/**
 * EL TERCER SITIO QUE RESPONDE A «¿TRABAJA AQUÍ?»: LA AGENDA.
 *
 * La marca valía para salir en los selectores (T1–T3) y para entrar a la sede
 * (T4), pero el listado de citas filtraba por `clinics[]` a secas. Con eso, la
 * enfermera marcada como «en todas» y asignada a Central abría el calendario y
 * no veía NINGUNA cita: las suyas del día estaban agendadas en la otra sucursal
 * —se las ponía mostrador desde allí— y para la consulta no existían. Ni para
 * verlas, ni para reclamarlas: la escritura repetía el mismo cálculo.
 */
const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const appt = require('../controllers/appointmentController');

/** La agenda tal y como la pide la pantalla: vista unificada (`clinic=all`). */
async function agendaDe(persona, sedeActiva) {
  const req = H.mockReq(sedeActiva, persona._id, {}, {
    role: persona.clinics[0].role,
    query: { clinic: 'all' },
  });
  // El alcance se decide con `clinics[]` + `worksInAllClinics`, así que el req
  // tiene que llevar el usuario entero, no solo su id.
  req.user = persona;
  return ok(await H.runController(appt.getAppointments, req)).map((a) => String(a._id));
}

/** Una cita de enfermería en `sede`, con el turno de `dueño` (o libre). */
async function citaDeEnfermeria(sede, dueño = null) {
  const paciente = await Patient.create({ clinic: sede, firstName: 'Ana', lastName: 'Pérez' });
  return Appointment.create({
    clinic: sede,
    patient: paciente._id,
    date: H.docDate(),
    startTime: '10:00',
    // 'asistida' = el paciente ya está delante, que es como llegan a enfermería.
    status: 'asistida',
    turns: [{ kind: 'enfermeria', user: dueño, status: 'pendiente', order: 0 }],
    currentTurnKind: 'enfermeria',
    currentTurnUser: dueño,
  });
}

test('T9) la enfermera que rota ve en su agenda la cita de la OTRA sucursal', async () => {
  const { central, extension, enfRotativa } = await seed();
  const suya = await citaDeEnfermeria(extension, enfRotativa._id);

  const agenda = await agendaDe(enfRotativa, central);
  assert.deepEqual(agenda, [String(suya._id)], 'su sede activa es Central y la cita es de Extensión');
});

test('T10) la enfermera de una sola sede sigue viendo solo la suya', async () => {
  const { central, extension } = await seed();
  const fija = await User.create({
    name: 'EnfFija', email: 'enffija@t.com', password: 'secreto123',
    clinics: [{ clinic: central, role: 'enfermero' }],
  });
  await citaDeEnfermeria(extension, fija._id);
  const enSuSede = await citaDeEnfermeria(central, fija._id);

  const agenda = await agendaDe(fija, central);
  assert.deepEqual(agenda, [String(enSuSede._id)], 'la de Extensión no es asunto suyo');
});

/**
 * Verla y no poder tocarla es peor que no verla: es el «Cita no encontrada» al
 * pulsar el botón. Leer y escribir salen de la misma función a propósito.
 */
test('T11) y puede reclamar esa cita, no solo verla', async () => {
  const { central, extension, enfRotativa } = await seed();
  const libre = await citaDeEnfermeria(extension, null);

  const req = H.mockReq(central, enfRotativa._id, {}, {
    role: 'enfermero',
    params: { id: String(libre._id) },
  });
  // Igual que en la agenda: el alcance sale del usuario entero (así lo deja
  // `middleware/auth`, que carga el documento completo salvo contraseñas).
  req.user = enfRotativa;
  const r = await H.runController(appt.nurseClaim, req);
  assert.ok(r.statusCode < 400, JSON.stringify(r.payload));
  const guardada = await Appointment.findById(libre._id);
  assert.equal(String(guardada.currentTurnUser), String(enfRotativa._id));
});
