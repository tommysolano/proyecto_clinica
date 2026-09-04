/**
 * LA HISTORIA CLÍNICA ES DEL PACIENTE, NO DE LA SUCURSAL.
 *
 * `clinicalrecords` nació con índice único (clinic, patient): una ficha POR SEDE.
 * Con una sola sucursal nadie lo notaba. Al abrir la segunda salió lo que tenía
 * que salir: el mismo paciente tenía dos historias y cada una era invisible desde
 * la otra. Y lo grave no era ver menos, era lo que el sistema hacía a
 * continuación — no encontraba la ficha de la otra sede y CREABA UNA NUEVA EN
 * BLANCO, así que el médico de Extensión veía a un paciente sin alergias, sin
 * antecedentes y sin ninguna consulta previa, sin ninguna señal de que
 * existieran.
 *
 * Aquí se vigilan las dos mitades: que leer y escribir vayan siempre a LA MISMA
 * ficha venga la petición de la sede que venga, y que la tarea que funde las
 * fichas ya duplicadas no pierda ni un seguimiento por el camino.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const Appointment = require('../models/Appointment');
const records = require('../controllers/clinicalRecordController');

const { fundirHistorias, elegirGanadora, BACKUP_COLL } = require('../scripts/mergeClinicalRecordsOnce');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const ok = (r) => { assert.ok(r.statusCode < 400, JSON.stringify(r.payload)); return r.payload; };

async function seed({ conFicha = true } = {}) {
  const { clinicId: central, userId } = await H.seedClinic();
  await Clinic.create({ _id: central, name: 'Central' });
  const extension = (await Clinic.create({ name: 'Extension' }))._id;
  const patient = await Patient.create({ clinic: central, firstName: 'JIMMY', lastName: 'ROA' });
  // `addFollowUp` no crea la ficha (upsert: false): exige que exista, como en la
  // aplicación, donde abrir al paciente ya la abre.
  if (conFicha) await ClinicalRecord.create({ clinic: central, patient: patient._id, createdBy: userId });
  return { central, extension, userId, patient };
}

/**
 * Deja la colección como estaba ANTES de la migración: sin el candado por
 * paciente, que es justo lo que permitía la segunda ficha. Los tests de la tarea
 * tienen que poder reproducir ese estado; `resetDb` borra documentos, no
 * índices, así que uno construido por un test anterior sigue puesto.
 */
async function sinCandadoPorPaciente() {
  try { await mongoose.connection.db.collection('clinicalrecords').dropIndex('patient_1'); } catch (_) {}
}

const abrirFicha = (clinicId, userId, patientId, role = 'doctor') =>
  H.runController(
    records.getOrCreateByPatient,
    H.mockReq(clinicId, userId, {}, { role, params: { patientId: String(patientId) } })
  );

const escribirSeguimiento = (clinicId, userId, patientId, body, role = 'doctor') =>
  H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, userId, body, { role, params: { patientId: String(patientId) } })
  );

/**
 * EL CASO QUE REPORTÓ LA CLÍNICA. Sin el arreglo, la segunda sede abre una ficha
 * nueva y este test ve `followUps.length === 0`.
 */
test('H1) lo escrito en una sucursal se lee desde la otra, y no nace una segunda ficha', async () => {
  const { central, extension, userId, patient } = await seed();

  ok(await escribirSeguimiento(central, userId, patient._id, {
    motivoConsulta: 'Dolor de cabeza',
    diagnosticos: [{ descripcion: 'Cefalea tensional' }],
  }));

  const desdeExtension = ok(await abrirFicha(extension, userId, patient._id));
  assert.equal(desdeExtension.followUps.length, 1, 'la consulta de Central se ve desde Extensión');
  assert.equal(desdeExtension.followUps[0].motivoConsulta, 'Dolor de cabeza');

  assert.equal(
    await ClinicalRecord.countDocuments({ patient: patient._id }),
    1,
    'y NO se ha abierto una segunda historia clínica'
  );
});

test('H2) los antecedentes también: se escriben en una sede y se leen en la otra', async () => {
  const { central, extension, userId, patient } = await seed();

  ok(await H.runController(
    records.updateByPatient,
    H.mockReq(central, userId, { alergias: 'Penicilina', antecedentesMedicamentos: 'Losartán 50mg' },
      { role: 'doctor', params: { patientId: String(patient._id) } })
  ));

  const desdeExtension = ok(await abrirFicha(extension, userId, patient._id));
  // Es LO ÚNICO que puede evitar una reacción, y era justo lo que desaparecía.
  assert.equal(desdeExtension.alergias, 'Penicilina');
  assert.equal(desdeExtension.antecedentesMedicamentos, 'Losartán 50mg');
  assert.equal(await ClinicalRecord.countDocuments({ patient: patient._id }), 1);
});

test('H3) los seguimientos se acumulan en la MISMA ficha aunque se escriban en sedes distintas', async () => {
  const { central, extension, userId, patient } = await seed();

  ok(await escribirSeguimiento(central, userId, patient._id, { motivoConsulta: 'Primera, en Central' }));
  ok(await escribirSeguimiento(extension, userId, patient._id, { motivoConsulta: 'Segunda, en Extensión' }));

  const fichas = await ClinicalRecord.find({ patient: patient._id }).lean();
  assert.equal(fichas.length, 1, 'una sola historia');
  assert.deepEqual(
    fichas[0].followUps.map((f) => f.motivoConsulta),
    ['Primera, en Central', 'Segunda, en Extensión']
  );
});

/**
 * El candado. Sin el índice único por paciente, dos altas simultáneas desde sedes
 * distintas vuelven a dejar dos historias y el problema renace en silencio.
 */
test('H4) la base RECHAZA una segunda ficha para el mismo paciente', async () => {
  const { central, extension, userId, patient } = await seed();
  await ClinicalRecord.init(); // que los índices estén construidos antes de probarlos

  await assert.rejects(
    () => ClinicalRecord.create({ clinic: extension, patient: patient._id, createdBy: userId }),
    (e) => e.code === 11000,
    'el índice único por paciente es lo que impide que vuelva a pasar'
  );
});

/** El adjunto vive en la carpeta de la sede donde se subió, no en la de quien lo abre. */
test('H5) el adjunto guarda en qué sucursal se subió', async () => {
  const { central, extension, userId, patient } = await seed();
  ok(await escribirSeguimiento(central, userId, patient._id, { motivoConsulta: 'Ecografía' }));
  const ficha = await ClinicalRecord.findOne({ patient: patient._id });
  const followUpId = String(ficha.followUps[0]._id);

  const req = H.mockReq(central, userId, {}, {
    role: 'doctor',
    params: { patientId: String(patient._id), followUpId },
  });
  req.file = {
    filename: '1757000000000-abcdef.pdf',
    originalname: 'eco.pdf',
    mimetype: 'application/pdf',
    size: 1234,
    path: '/tmp/no-existe',
  };
  ok(await H.runController(records.uploadFollowUpAttachment, req));

  const tras = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const att = tras.followUps[0].attachments[0];
  assert.equal(String(att.clinic), String(central), 'sin esto, abrirlo desde Extensión daba "no existe en disco"');
  assert.notEqual(String(att.clinic), String(extension));
});

// ─────────────────── La tarea que funde lo ya duplicado ───────────────────

test('H6) fundir dos historias reúne los seguimientos EN ORDEN y rellena los huecos', async () => {
  const { central, extension, patient } = await seed({ conFicha: false });
  await sinCandadoPorPaciente();

  // Se saltan los validadores del modelo a propósito: se está reproduciendo el
  // estado que dejó el índice viejo, que hoy la aplicación ya no puede crear.
  const coll = mongoose.connection.db.collection('clinicalrecords');
  const enero = new Date('2026-01-10T12:00:00Z');
  const marzo = new Date('2026-03-05T12:00:00Z');
  const agosto = new Date('2026-08-20T12:00:00Z');

  const vieja = {
    _id: new mongoose.Types.ObjectId(), clinic: central, patient: patient._id,
    alergias: 'Penicilina', createdAt: enero, updatedAt: enero,
    followUps: [
      { _id: new mongoose.Types.ObjectId(), fecha: enero, motivoConsulta: 'Enero, en Central' },
      { _id: new mongoose.Types.ObjectId(), fecha: agosto, motivoConsulta: 'Agosto, en Central' },
    ],
  };
  const nueva = {
    _id: new mongoose.Types.ObjectId(), clinic: extension, patient: patient._id,
    // La otra no lo tenía: al fundir, este dato tiene que sobrevivir.
    antecedentesQuirurgicos: 'Apendicectomía 2019',
    // Y este SÍ está en las dos: gana la que se queda, no se pisa.
    alergias: 'Ninguna',
    createdAt: marzo, updatedAt: marzo,
    followUps: [{ _id: new mongoose.Types.ObjectId(), fecha: marzo, motivoConsulta: 'Marzo, en Extensión' }],
  };
  await coll.insertMany([vieja, nueva]);

  const resumen = await fundirHistorias({ commit: true, log: () => {} });
  assert.equal(resumen.fundidas, 1);

  const quedan = await coll.find({ patient: patient._id }).toArray();
  assert.equal(quedan.length, 1, 'una sola historia');
  const ficha = quedan[0];

  // EN ORDEN: pegar el bloque al final dejaría marzo después de agosto, y una
  // historia clínica se lee en orden.
  assert.deepEqual(
    ficha.followUps.map((f) => f.motivoConsulta),
    ['Enero, en Central', 'Marzo, en Extensión', 'Agosto, en Central']
  );
  assert.equal(ficha.antecedentesQuirurgicos, 'Apendicectomía 2019', 'el hueco se rellena con la otra ficha');
  assert.equal(ficha.alergias, 'Penicilina', 'lo que ya estaba escrito NO se pisa');

  // Y la absorbida queda guardada entera: el M0 no tiene backups.
  const copia = await mongoose.connection.db.collection(BACKUP_COLL).find({}).toArray();
  assert.equal(copia.length, 1);
  assert.equal(copia[0].followUps.length, 1);
  assert.equal(String(copia[0]._mergedInto), String(ficha._id));
});

test('H7) se queda la ficha con más seguimientos; a igualdad, la más antigua', async () => {
  const a = { _id: 'a', followUps: [1, 2], createdAt: new Date('2026-05-01') };
  const b = { _id: 'b', followUps: [1, 2, 3], createdAt: new Date('2026-06-01') };
  assert.equal(elegirGanadora([a, b])._id, 'b', 'la que más historia tiene');

  const c = { _id: 'c', followUps: [1], createdAt: new Date('2026-02-01') };
  const d = { _id: 'd', followUps: [1], createdAt: new Date('2026-07-01') };
  assert.equal(elegirGanadora([d, c])._id, 'c', 'a igualdad, donde empezó la historia');
});

test('H8) la tarea es idempotente: correrla dos veces no cambia nada', async () => {
  const { central, extension, patient } = await seed({ conFicha: false });
  await sinCandadoPorPaciente();
  const coll = mongoose.connection.db.collection('clinicalrecords');
  await coll.insertMany([
    { _id: new mongoose.Types.ObjectId(), clinic: central, patient: patient._id, followUps: [{ _id: new mongoose.Types.ObjectId(), fecha: new Date(), motivoConsulta: 'A' }], createdAt: new Date('2026-01-01') },
    { _id: new mongoose.Types.ObjectId(), clinic: extension, patient: patient._id, followUps: [{ _id: new mongoose.Types.ObjectId(), fecha: new Date(), motivoConsulta: 'B' }], createdAt: new Date('2026-02-01') },
  ]);

  await fundirHistorias({ commit: true, log: () => {} });
  const primera = await coll.findOne({ patient: patient._id });

  const segunda = await fundirHistorias({ commit: true, log: () => {} });
  assert.equal(segunda.fundidas, 0, 'la segunda pasada no encuentra nada que fundir');
  const tras = await coll.findOne({ patient: patient._id });
  assert.equal(tras.followUps.length, primera.followUps.length, 'ni duplica seguimientos');
  assert.equal(await coll.countDocuments({ patient: patient._id }), 1);
});

/**
 * La ATENCIÓN de una cita escribe su parte en la ficha. Antes buscaba la de
 * `apt.clinic`; si esa sede no tenía ficha, abría una segunda.
 */
test('H9) cerrar el turno de una cita escribe en la ficha que ya existe', async () => {
  const { central, extension, userId, patient } = await seed();
  ok(await escribirSeguimiento(central, userId, patient._id, { motivoConsulta: 'Consulta previa en Central' }));

  await Appointment.create({
    clinic: extension, patient: patient._id, date: H.docDate(), startTime: '09:00',
    status: 'asistida', createdBy: userId,
  });

  const ficha = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  assert.equal(String(ficha.clinic), String(central), 'la ficha recuerda dónde se abrió…');
  assert.equal(await ClinicalRecord.countDocuments({ patient: patient._id }), 1, '…y sigue siendo una sola');
});
