/**
 * VARIOS ENFERMEROS EN UNA MISMA CITA.
 *
 * El caso real: un detox lo atiende primero un enfermero y, cuando termina, lo
 * continúa otro con el suero. Cada uno hace algo distinto y las dos cosas tienen
 * que quedar registradas por separado.
 *
 * Lo que estos tests vigilan, porque se rompió una vez y en silencio:
 *  1. `attendedByNurse` era un campo que se escribía al reclamar y NO se soltaba
 *     nunca. Con dos turnos seguidos se quedaba clavado en el primero: al
 *     segundo la cita NO le aparecía en la bandeja, y si llegaba a ella recibía
 *     un 403 al terminar. Ahora es un ESPEJO del turno y quien manda es
 *     `turns[].user`.
 *  2. La cola es estricta también dentro de enfermería: el segundo turno no
 *     existe para nadie hasta que el primero se cierre. Si se abriera antes,
 *     dos personas estarían con el mismo paciente.
 *  3. Un turno NOMBRADO es de esa persona: nadie más puede tomarlo.
 *  4. Cada turno lleva SU servicio, que es lo único que distingue el detox del
 *     suero en el seguimiento automático. Antes los dos partes salían idénticos.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const appt = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });

  const enf1 = await crear('Enf1', 'enfermero');
  const enf2 = await crear('Enf2', 'enfermero');
  const docA = await crear('DocA', 'doctor');

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });

  return { clinicId, userId, patient, enf1, enf2, docA, cita };
}

const params = (id) => ({ params: { id: String(id) } });
const comoEnfermero = (clinicId, userId, id, body = {}) =>
  H.mockReq(clinicId, userId, body, { role: 'enfermero', ...params(id) });

/** Ids de las citas que este enfermero ve en su bandeja. */
async function bandeja(clinicId, userId) {
  const r = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, userId, {}, { role: 'enfermero', query: {} }),
  );
  const lista = Array.isArray(r.payload) ? r.payload : r.payload?.appointments || [];
  return lista.map((a) => String(a._id));
}

// ───────────────────── dos turnos en secuencia ─────────────────────

test('un detox con dos pasos de enfermería: los atiende uno y luego el otro', async () => {
  const { clinicId, userId, enf1, enf2, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [
      { kind: 'enfermeria', serviceName: 'Detox' },
      { kind: 'enfermeria', serviceName: 'Sueroterapia' },
    ],
  }, params(cita._id)));

  // El primero lo toma Enf1.
  const r1 = await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf1._id, cita._id));
  assert.equal(r1.statusCode < 400, true, JSON.stringify(r1.payload));

  // Mientras Enf1 no termine, el segundo turno NO está disponible: si Enf2 lo
  // intentara, se pondría con el mismo paciente que su compañero.
  const choque = await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf2._id, cita._id));
  assert.equal(choque.statusCode, 409, JSON.stringify(choque.payload));

  // Enf1 termina lo suyo.
  const fin1 = await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enf1._id, cita._id));
  assert.equal(fin1.statusCode < 400, true, JSON.stringify(fin1.payload));

  const media = await Appointment.findById(cita._id).lean();
  assert.equal(media.turns[0].status, 'completado');
  assert.equal(String(media.turns[0].user), String(enf1._id));
  assert.equal(media.currentTurnKind, 'enfermeria', 'ahora le toca al segundo turno');
  assert.equal(media.currentTurnUser, null, 'que quedó abierto: lo toma quien pueda');
  assert.equal(media.status, 'asistida', 'la cita NO se cierra: falta el suero');

  // Y ahora sí: Enf2 puede tomarlo.
  const r2 = await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf2._id, cita._id));
  assert.equal(r2.statusCode < 400, true, JSON.stringify(r2.payload));
  const fin2 = await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enf2._id, cita._id));
  assert.equal(fin2.statusCode < 400, true, JSON.stringify(fin2.payload));

  const fin = await Appointment.findById(cita._id).lean();
  assert.equal(String(fin.turns[1].user), String(enf2._id));
  assert.equal(fin.turns[1].status, 'completado');
  assert.equal(fin.status, 'completada', 'ya no queda nadie pendiente');
});

test('al segundo enfermero la cita SÍ le aparece en su bandeja cuando le toca', async () => {
  const { clinicId, userId, enf1, enf2, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria' }, { kind: 'enfermeria' }],
  }, params(cita._id)));

  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf1._id, cita._id));

  // Con el turno de Enf1 en marcha, a Enf2 no le aparece.
  assert.equal((await bandeja(clinicId, enf2._id)).includes(String(cita._id)), false);

  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enf1._id, cita._id));

  // Este es EL fallo que motivó el cambio: antes `attendedByNurse` seguía
  // apuntando a Enf1 y la cita no volvía a salir para nadie.
  assert.equal(
    (await bandeja(clinicId, enf2._id)).includes(String(cita._id)),
    true,
    'el segundo turno tiene que salir a la bandeja al quedar libre',
  );
  // Y a Enf1 no se le cae de la lista: ya atendió, es parte de su día.
  assert.equal((await bandeja(clinicId, enf1._id)).includes(String(cita._id)), true);
});

// ───────────────────── turno nombrado ─────────────────────

test('un turno nombrado es de esa persona: nadie más puede tomarlo', async () => {
  const { clinicId, userId, enf1, enf2, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria', user: String(enf1._id), serviceName: 'Detox' }],
  }, params(cita._id)));

  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(String(guardada.turns[0].user), String(enf1._id), 'nace con dueño');
  assert.equal(String(guardada.currentTurnUser), String(enf1._id));

  // A Enf2 ni le aparece…
  assert.equal((await bandeja(clinicId, enf2._id)).includes(String(cita._id)), false);
  // …ni puede tomarlo si lo intenta desde una pantalla vieja.
  const r = await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf2._id, cita._id));
  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));

  // A Enf1 sí.
  assert.equal((await bandeja(clinicId, enf1._id)).includes(String(cita._id)), true);
  const ok = await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf1._id, cita._id));
  assert.equal(ok.statusCode < 400, true, JSON.stringify(ok.payload));
});

test('se pueden mezclar: primero uno nombrado y después quien esté libre', async () => {
  const { clinicId, userId, enf1, enf2, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [
      { kind: 'enfermeria', user: String(enf1._id), serviceName: 'Detox' },
      { kind: 'enfermeria', serviceName: 'Sueroterapia' },
    ],
  }, params(cita._id)));

  const a = await Appointment.findById(cita._id).lean();
  assert.equal(String(a.turns[0].user), String(enf1._id));
  assert.equal(a.turns[1].user, null, 'el segundo queda abierto');

  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf1._id, cita._id));
  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enf1._id, cita._id));

  // El segundo, al ser abierto, lo puede tomar cualquiera — incluido Enf2.
  const r = await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf2._id, cita._id));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const fin = await Appointment.findById(cita._id).lean();
  assert.equal(String(fin.turns[1].user), String(enf2._id));
});

// ───────────────────── qué hizo cada uno ─────────────────────

test('cada enfermero deja SU seguimiento, con el servicio de su turno', async () => {
  const { clinicId, userId, patient, enf1, enf2, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [
      { kind: 'enfermeria', serviceName: 'Detox' },
      { kind: 'enfermeria', serviceName: 'Sueroterapia' },
    ],
  }, params(cita._id)));

  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf1._id, cita._id));
  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enf1._id, cita._id));
  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf2._id, cita._id));
  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enf2._id, cita._id));

  const rec = await ClinicalRecord.findOne({ clinic: clinicId, patient: patient._id }).lean();
  const notas = rec.followUps.filter((f) => f.kind === 'enfermeria');
  assert.equal(notas.length, 2, 'una nota por enfermero');

  // Lo que se rompía antes: los dos partes decían «Servicio de enfermería» y no
  // había forma de saber cuál fue el detox y cuál el suero.
  const textos = notas.map((n) => n.motivoConsulta);
  assert.ok(textos.some((t) => /Detox/i.test(t)), `falta el detox en ${JSON.stringify(textos)}`);
  assert.ok(textos.some((t) => /Sueroterapia/i.test(t)), `falta el suero en ${JSON.stringify(textos)}`);

  // Y cada una firmada por quien la hizo.
  const autores = notas.map((n) => String(n.createdBy)).sort();
  assert.deepEqual(autores, [String(enf1._id), String(enf2._id)].sort());
});

test('el espejo attendedByNurse sigue al turno, sin quedarse clavado en el primero', async () => {
  const { clinicId, userId, enf1, enf2, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria' }, { kind: 'enfermeria' }],
  }, params(cita._id)));

  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf1._id, cita._id));
  let a = await Appointment.findById(cita._id).lean();
  assert.equal(String(a.attendedByNurse), String(enf1._id));

  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enf1._id, cita._id));
  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf2._id, cita._id));
  a = await Appointment.findById(cita._id).lean();
  assert.equal(String(a.attendedByNurse), String(enf2._id), 'el espejo pasa al que atiende AHORA');
});

// ───────────────────── carreras ─────────────────────

test('dos enfermeros a la vez sobre un turno abierto: lo gana uno solo', async () => {
  const { clinicId, userId, enf1, enf2, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria' }, { kind: 'enfermeria' }],
  }, params(cita._id)));

  const [r1, r2] = await Promise.all([
    H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf1._id, cita._id)),
    H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf2._id, cita._id)),
  ]);
  const codigos = [r1.statusCode, r2.statusCode].sort();
  assert.deepEqual(codigos, [200, 409], `${JSON.stringify(r1.payload)} / ${JSON.stringify(r2.payload)}`);

  // Y el turno tiene UN dueño, no dos.
  const a = await Appointment.findById(cita._id).lean();
  assert.ok(a.turns[0].user, 'el primer turno quedó con dueño');
  assert.equal(a.turns[1].user, null, 'el segundo sigue intacto y abierto');
});

// ───────────────────── que no se rompa lo de antes ─────────────────────

test('un solo paso de enfermería abierto se sigue comportando como siempre', async () => {
  const { clinicId, userId, enf1, enf2, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria' }],
  }, params(cita._id)));

  // Les aparece a los dos mientras está libre.
  assert.equal((await bandeja(clinicId, enf1._id)).includes(String(cita._id)), true);
  assert.equal((await bandeja(clinicId, enf2._id)).includes(String(cita._id)), true);

  await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf1._id, cita._id));

  // En cuanto uno la toma, desaparece para el otro.
  assert.equal((await bandeja(clinicId, enf2._id)).includes(String(cita._id)), false);
  assert.equal((await bandeja(clinicId, enf1._id)).includes(String(cita._id)), true);

  await H.runController(appt.nurseComplete, comoEnfermero(clinicId, enf1._id, cita._id));
  const a = await Appointment.findById(cita._id).lean();
  assert.equal(a.status, 'completada');
});

test('enfermería detrás de un doctor sigue sin salir hasta que él termina', async () => {
  const { clinicId, userId, docA, enf1, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: String(docA._id) }, { kind: 'enfermeria', user: String(enf1._id) }],
  }, params(cita._id)));

  // Aunque el turno esté NOMBRADO a Enf1, todavía no es suyo: manda la cola.
  assert.equal((await bandeja(clinicId, enf1._id)).includes(String(cita._id)), false);
  const r = await H.runController(appt.nurseClaim, comoEnfermero(clinicId, enf1._id, cita._id));
  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  assert.equal(r.payload.code, 'NOT_YOUR_TURN');
});

// ───────────── el contrato del que depende la agenda ─────────────

/**
 * Estos dos fijan lo que la PANTALLA necesita para no ofrecer «Atender» a quien
 * no le toca. El espejo `doctor` y `currentTurnUser` dicen cosas DISTINTAS a
 * propósito, y confundirlos fue el fallo: el doctor que ya había guardado su
 * seguimiento seguía viendo el botón de atender a un paciente que ya estaba con
 * enfermería.
 */
test('cuando el doctor termina y pasa a enfermería, el espejo sigue en él pero el turno NO', async () => {
  const { clinicId, userId, docA, cita, patient } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: String(docA._id) }, { kind: 'enfermeria' }],
  }, params(cita._id)));

  const records = require('../controllers/clinicalRecordController');
  const r = await H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, docA._id, { motivoConsulta: 'Control', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const a = await Appointment.findById(cita._id).lean();
  // El espejo se queda con el último doctor: lo leen comisiones y reportes, y la
  // cita no puede perder a su médico.
  assert.equal(String(a.doctor), String(docA._id), 'el espejo conserva al doctor');
  // Pero la pelota ya NO es suya. Es lo que la agenda tiene que mirar.
  assert.equal(a.currentTurnKind, 'enfermeria');
  assert.equal(a.currentTurnUser, null, 'nadie la tiene: sale a la bandeja de enfermería');
  assert.notEqual(String(a.currentTurnUser || ''), String(docA._id));
  // Y su turno consta como completado, que es lo que permite decir «Ya atendida».
  const suyo = a.turns.find((t) => String(t.user) === String(docA._id));
  assert.equal(suyo.status, 'completado');
});

test('con dos doctores, al primero deja de tocarle en cuanto guarda', async () => {
  const { clinicId, userId, docA, cita, patient } = await seed();
  const docB = await User.create({
    name: 'DocB', email: 'docb@t.com', password: 'secreto123',
    clinics: [{ clinic: clinicId, role: 'doctor' }],
  });
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: String(docA._id) }, { kind: 'doctor', user: String(docB._id) }],
  }, params(cita._id)));

  const antes = await Appointment.findById(cita._id).lean();
  assert.equal(String(antes.currentTurnUser), String(docA._id), 'empieza el primero');

  const records = require('../controllers/clinicalRecordController');
  await H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, docA._id, { motivoConsulta: 'Control', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );

  const a = await Appointment.findById(cita._id).lean();
  assert.equal(String(a.currentTurnUser), String(docB._id), 'la pelota pasa al segundo');
  assert.notEqual(String(a.currentTurnUser), String(docA._id), 'al primero ya no le toca');
});
