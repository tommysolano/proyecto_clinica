/**
 * EL SUERO SE ESCRIBE SOLO AL AGENDAR.
 *
 * Enfermería no lee la cita: lee la ficha. Lo que puede dar por aplicado —y lo
 * que descuenta la ampolla del inventario— es una línea de receta con `isSerum`,
 * y hasta ahora esa línea la tenía que teclear alguien, paciente por paciente.
 * Con «Detox Plus», que es siempre la misma bolsa, eso era copiar y pegar
 * veintitrés veces al mes; el día que se olvida, la aplicación no queda
 * registrada y la ampolla sigue contando en la percha.
 *
 * Dos puertas, la misma salida:
 *  1. el SERVICIO trae su suero de serie (`AppointmentServiceItem.autoSerum`);
 *  2. quien agenda lo indica a mano al mandar la cita a un enfermero.
 *
 * Y de paso se vigila lo otro que trajo el mismo cambio: que se pueda ELEGIR
 * QUIÉN ATIENDE ya al agendar, sin que eso dé la cita por atendida.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const Clinic = require('../models/Clinic');
const ClinicalRecord = require('../models/ClinicalRecord');
const Patient = require('../models/Patient');
const User = require('../models/User');
const appt = require('../controllers/appointmentController');
const serviceItems = require('../controllers/appointmentServiceItemController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

// El código real de la ampolla del catálogo de sueroterapia. Se usa el de
// verdad a propósito: lo que importa es que la plantilla se guarde CON código,
// porque sin él la ampolla no se encuentra en el inventario al aplicarla.
const DETOX = { code: 'NOVDE01', name: 'SUEROTERAPIA DETOX PLUS' };

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  await Clinic.create({ _id: clinicId, name: 'Central' });
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });
  const doctora = await crear('Doc', 'doctor');
  const enfermera = await crear('Enf', 'enfermero');
  return { clinicId, userId, patient, doctora, enfermera };
}

/** Mañana, para no chocar con «no se agenda en una hora que ya pasó». */
const manana = () => {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

const agendar = (clinicId, userId, body, role = 'cajero') =>
  H.runController(appt.createAppointment, H.mockReq(clinicId, userId, body, { role }));

const sueroDeLaFicha = async (patientId) => {
  const rec = await ClinicalRecord.findOne({ patient: patientId }).lean();
  const items = (rec?.followUps || []).flatMap((f) => (f.recetaItems || []).filter((i) => i.isSerum));
  return { rec, items };
};

test('T1) el servicio con suero de serie lo escribe solo en los seguimientos', async () => {
  const { clinicId, userId, patient } = await seed();
  const servicio = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Detox Plus', slug: 'detox plus',
    autoSerum: {
      enabled: true,
      base: { name: 'Cloruro', volumeMl: 250 },
      components: [{ ...DETOX, grupo: 'ampolla', quantity: 1 }],
    },
  });

  const cita = ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '10:00', serviceItem: servicio._id,
  }));

  const { items } = await sueroDeLaFicha(patient._id);
  assert.equal(items.length, 1, 'una línea de suero, no más');
  assert.equal(items[0].name, 'Detox Plus', 'la línea se llama como el servicio');
  assert.equal(items[0].serumBase.volumeMl, 250);
  assert.deepEqual(
    items[0].serumComponents.map((c) => [c.code, c.name, c.quantity]),
    [[DETOX.code, DETOX.name, 1]],
    'la ampolla se guarda CON su código: sin él no se descuenta del inventario'
  );
  assert.deepEqual(cita.autoSerum?.items, ['Detox Plus'], 'la pantalla se entera de que ya está escrito');
});

test('T2) sin la marca activa, el servicio NO escribe nada', async () => {
  const { clinicId, userId, patient } = await seed();
  const servicio = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Consulta', slug: 'consulta',
    autoSerum: {
      enabled: false,
      base: { name: 'Cloruro', volumeMl: 250 },
      components: [{ ...DETOX, grupo: 'ampolla', quantity: 1 }],
    },
  });

  ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '10:00', serviceItem: servicio._id,
  }));

  const { rec } = await sueroDeLaFicha(patient._id);
  assert.equal(rec, null, 'ni siquiera se abre la ficha por una cita normal');
});

test('T3) el suero escogido al mandar la cita a un enfermero', async () => {
  const { clinicId, userId, patient, enfermera } = await seed();

  ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '11:00',
    steps: [{
      kind: 'enfermeria', user: enfermera._id,
      serum: { base: { volumeMl: 500 }, components: [{ name: 'APIMEL 2ML AMP', quantity: 2 }] },
    }],
  }));

  const { items } = await sueroDeLaFicha(patient._id);
  assert.equal(items.length, 1);
  assert.equal(items[0].serumBase.volumeMl, 500);
  assert.equal(items[0].serumComponents[0].quantity, 2);
  assert.ok(
    items[0].serumComponents[0].code,
    'escrito por su NOMBRE, se resuelve contra el catálogo y recupera el código'
  );
});

test('T4) el suero queda en el TURNO, y volver a guardar no lo escribe otra vez', async () => {
  const { clinicId, userId, patient, enfermera } = await seed();

  const cita = ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '12:00',
    steps: [{
      kind: 'enfermeria', user: enfermera._id,
      serum: { base: { volumeMl: 250 }, components: [{ ...DETOX, quantity: 1 }] },
    }],
  }));

  const guardada = await Appointment.findById(cita._id).lean();
  const turno = guardada.turns[0];
  assert.equal(turno.serum.components[0].code, DETOX.code, 'el turno recuerda qué se indicó');
  assert.ok(turno.serumFollowUp, 'y dónde quedó escrito');
  assert.equal((await sueroDeLaFicha(patient._id)).items.length, 1);

  // La pantalla devuelve la marca: reordenar la cola o añadir un doctor no puede
  // añadir una segunda bolsa a la ficha.
  const asignar = (steps) =>
    H.runController(
      appt.assignDoctor,
      H.mockReq(clinicId, userId, { steps }, { role: 'cajero', params: { id: String(cita._id) } })
    );
  ok(await asignar([{
    kind: 'enfermeria', user: String(enfermera._id),
    serum: { base: { volumeMl: 250 }, components: [{ ...DETOX, quantity: 1 }] },
    serumFollowUp: String(turno.serumFollowUp),
  }]));
  assert.equal((await sueroDeLaFicha(patient._id)).items.length, 1, 'sigue habiendo una sola');
});

test('T5) elegir quién atiende al agendar deja el turno puesto, NO la cita atendida', async () => {
  const { clinicId, userId, patient, doctora } = await seed();

  const cita = ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '09:00',
    steps: [{ kind: 'doctor', user: doctora._id }],
  }));

  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.turns.length, 1);
  assert.equal(String(guardada.turns[0].user), String(doctora._id));
  assert.equal(guardada.currentTurnKind, 'doctor');
  assert.equal(String(guardada.currentTurnUser), String(doctora._id));
  assert.equal(String(guardada.doctor), String(doctora._id), 'el espejo se sincroniza solo');
  assert.equal(guardada.status, 'pendiente', 'elegida NO es atendida: el paciente aún no ha venido');
});

test('T6) no se puede dejar elegido a personal de otra sucursal', async () => {
  const { clinicId, userId, patient } = await seed();
  const otra = await Clinic.create({ name: 'Extensión' });
  const ajeno = await User.create({
    name: 'Ajeno', email: 'ajeno@t.com', password: 'secreto123',
    clinics: [{ clinic: otra._id, role: 'doctor' }],
  });

  const r = await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '08:00',
    steps: [{ kind: 'doctor', user: ajeno._id }],
  });
  assert.equal(r.statusCode, 400);
  assert.match(r.payload.message, /no atiende en la sucursal/i);
  assert.equal(await Appointment.countDocuments({}), 0, 'y la cita no llega a crearse');
});

test('T7) los turnos no entran a pelo por el cuerpo de la petición', async () => {
  const { clinicId, userId, patient, doctora } = await seed();

  const cita = ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '15:00',
    // Un cliente malicioso (o viejo) mandando la cola ya montada: se ignora, y
    // con ella el espejo `doctor` y `currentTurn*` que la acompañarían.
    turns: [{ kind: 'doctor', user: doctora._id, status: 'completado', order: 0 }],
    currentTurnKind: 'doctor',
  }));

  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal((guardada.turns || []).length, 0);
  assert.equal(guardada.currentTurnKind ?? null, null);
});

test('T8) cambiar el servicio a uno con suero también lo escribe (y solo una vez)', async () => {
  const { clinicId, userId, patient } = await seed();
  const servicio = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Detox Plus', slug: 'detox plus',
    autoSerum: {
      enabled: true,
      base: { name: 'Cloruro', volumeMl: 250 },
      components: [{ ...DETOX, grupo: 'ampolla', quantity: 1 }],
    },
  });

  // Mostrador agenda sin servicio («viene mañana, ya veremos a qué»)…
  const cita = ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '16:00',
  }));
  assert.equal((await sueroDeLaFicha(patient._id)).items.length, 0);

  const editar = (body) =>
    H.runController(
      appt.updateAppointment,
      H.mockReq(clinicId, userId, body, { role: 'cajero', params: { id: String(cita._id) } })
    );

  // …y lo corrige después.
  ok(await editar({ serviceItem: String(servicio._id) }));
  assert.equal((await sueroDeLaFicha(patient._id)).items.length, 1);

  // Reeditar otra cosa NO añade una segunda bolsa.
  ok(await editar({ serviceItem: String(servicio._id), startTime: '17:00' }));
  assert.equal((await sueroDeLaFicha(patient._id)).items.length, 1, 'sigue habiendo una sola');
});

test('T10) ASIGNAR ATENCIÓN: el suero escogido ahí se escribe en los seguimientos', async () => {
  const { clinicId, userId, patient, enfermera } = await seed();
  const cita = ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '11:10',
  }));

  const r = ok(await H.runController(
    appt.assignDoctor,
    H.mockReq(
      clinicId, userId,
      {
        steps: [{
          kind: 'enfermeria', user: null, serviceName: 'Sueroterapia',
          serum: { base: { volumeMl: 250 }, components: [{ ...DETOX, quantity: 1 }] },
        }],
      },
      { role: 'cajero', params: { id: String(cita._id) } }
    )
  ));

  const { items } = await sueroDeLaFicha(patient._id);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'Sueroterapia', 'la línea se llama como el paso');
  assert.equal(items[0].serumComponents[0].code, DETOX.code);
  assert.deepEqual(r.autoSerum?.items, ['Sueroterapia'], 'y la pantalla lo dice');
  assert.ok(String(enfermera._id), 'el turno abierto vale igual: el suero no es de nadie en concreto');
});

test('T11) el suero escrito así es ADMINISTRABLE, igual que uno recetado por el doctor', async () => {
  const { clinicId, userId, patient, enfermera } = await seed();
  // La ampolla existe en el inventario: aplicar tiene que descontarla.
  const ampolla = await H.makeProduct(clinicId, { code: DETOX.code, name: DETOX.name, stock: 10 });

  const cita = ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '11:20',
  }));
  ok(await H.runController(
    appt.assignDoctor,
    H.mockReq(
      clinicId, userId,
      { steps: [{ kind: 'enfermeria', user: String(enfermera._id), serviceName: 'Detox',
        serum: { base: { volumeMl: 250 }, components: [{ ...DETOX, quantity: 1 }] } }] },
      { role: 'cajero', params: { id: String(cita._id) } }
    )
  ));

  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fu = rec.followUps[0];
  const item = fu.recetaItems[0];
  assert.ok(item._id, 'la línea tiene su propio _id: sin él no hay a qué apuntar el «Administrar»');

  // Y el enfermero la aplica por la MISMA ruta que un suero recetado.
  const records = require('../controllers/clinicalRecordController');
  ok(await H.runController(
    records.administerSerum,
    H.mockReq(clinicId, enfermera._id, { baseVolumeMl: 250 }, {
      role: 'enfermero',
      params: { patientId: String(patient._id), followUpId: String(fu._id), itemId: String(item._id) },
    })
  ));

  const despues = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const aplicaciones = despues.followUps[0].recetaItems[0].administrations;
  assert.equal(aplicaciones.length, 1, 'queda registrado que se aplicó');
  assert.equal(String(aplicaciones[0].by), String(enfermera._id));
  const Product = require('../models/Product');
  assert.equal((await Product.findById(ampolla._id)).stock, 9, 'y la ampolla sale del inventario');
});

test('T12) una cita YA agendada con servicio que trae suero lo recibe al asignar', async () => {
  const { clinicId, userId, patient } = await seed();
  // Se agenda ANTES de que el servicio tenga suero (o sea una cita vieja).
  const servicio = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Detox Plus', slug: 'detox plus',
  });
  const cita = ok(await agendar(clinicId, userId, {
    patient: patient._id, date: manana(), startTime: '13:00', serviceItem: servicio._id,
  }));
  assert.equal((await sueroDeLaFicha(patient._id)).items.length, 0);

  // Se configura el suero del servicio…
  await AppointmentServiceItem.updateOne({ _id: servicio._id }, {
    $set: {
      autoSerum: {
        enabled: true, base: { name: 'Cloruro', volumeMl: null },
        components: [{ ...DETOX, grupo: 'ampolla', quantity: 1 }],
      },
    },
  });

  const asignar = () =>
    H.runController(
      appt.assignDoctor,
      H.mockReq(clinicId, userId, { steps: [{ kind: 'enfermeria', user: null }] },
        { role: 'cajero', params: { id: String(cita._id) } })
    );

  ok(await asignar());
  assert.equal((await sueroDeLaFicha(patient._id)).items.length, 1, 'se recupera al asignar');
  ok(await asignar());
  assert.equal((await sueroDeLaFicha(patient._id)).items.length, 1, 'y no se repite');
});

test('T9) el suero de serie se configura desde el catálogo, y sin ampollas se apaga', async () => {
  const { clinicId, userId } = await seed();
  const servicio = await AppointmentServiceItem.create({
    clinic: clinicId, name: 'Detox Plus', slug: 'detox plus',
  });

  const guardar = (autoSerum) =>
    H.runController(
      serviceItems.update,
      H.mockReq(clinicId, userId, { autoSerum }, { role: 'admin', params: { id: String(servicio._id) } })
    );

  // Se escribe la ampolla por su nombre: tiene que salir con su código.
  const conSuero = ok(await guardar({
    enabled: true,
    base: { name: 'Cloruro', volumeMl: 250 },
    components: [{ name: DETOX.name, quantity: 1 }],
  }));
  assert.equal(conSuero.autoSerum.enabled, true);
  assert.equal(conSuero.autoSerum.components[0].code, DETOX.code);

  // Vaciarlo lo apaga: un suero sin nada dentro llenaría la ficha de líneas en
  // blanco cada vez que se agenda el servicio.
  const vacio = ok(await guardar({ enabled: true, base: { volumeMl: 250 }, components: [] }));
  assert.equal(vacio.autoSerum.enabled, false);
});
