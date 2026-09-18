/**
 * REPRODUCCIÓN del reporte (sep-2026): el odontólogo NEUROFOCAL atiende,
 * termina el seguimiento, receta un suero y guarda — y la cita se le queda
 * «sin guardar» y sigue viva, y el suero nunca le llega a la enfermera.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const Notification = require('../models/Notification');
const appt = require('../controllers/appointmentController');
const records = require('../controllers/clinicalRecordController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Dario', lastName: 'Cabezas', cedula: '0102030406',
  });

  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });

  const odonto = await crear('OdontoNF', 'odontologia_neurofocal');
  const enf = await crear('EnfX', 'enfermero');

  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });

  return { clinicId, userId, patient, odonto, enf, cita };
}

const comoCita = (clinicId, userId, id, role, body = {}) =>
  H.mockReq(clinicId, userId, body, { role, params: { id: String(id) } });
const comoFicha = (clinicId, userId, patientId, role, body = {}) =>
  H.mockReq(clinicId, userId, body, { role, params: { patientId: String(patientId) } });

async function bandeja(clinicId, userId, role) {
  const r = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, userId, {}, { role, query: {} }),
  );
  const lista = Array.isArray(r.payload) ? r.payload : r.payload?.appointments || [];
  return lista.map((a) => String(a._id));
}

const SUERO = {
  name: 'Sueroterapia',
  quantity: 1,
  isSerum: true,
  serumBase: { name: 'Cloruro de sodio', volumeMl: 250 },
  serumComponents: [{ name: 'Vitamina C', quantity: 1 }],
};

test('odontologia_neurofocal guarda su seguimiento con suero y la cita queda RETENIDA hasta que mostrador asigne', async () => {
  /**
   * Sep-2026, a pedido de la clínica: el suero que recetó el doctor NO siempre
   * es el que toca aplicar en ese momento. Al guardar el seguimiento con la
   * receta y pasar el turno a enfermería —sin suero escogido en el paso—, la
   * cita NO sale a la bandeja del enfermero: queda retenida
   * (`serumStatus='por_asignar'`) con su indicativo en la agenda general, y
   * mostrador decide en «Asignar atención». Ahí se libera.
   */
  const { clinicId, userId, patient, odonto, enf, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: odonto._id }, { kind: 'enfermeria', serviceName: 'Sueroterapia' }],
  }, { params: { id: String(cita._id) } }));

  const r = await H.runController(records.addFollowUp, comoFicha(clinicId, odonto._id, patient._id, 'odontologia_neurofocal', {
    descripcion: 'Consulta de odontología neurofocal',
    appointmentId: String(cita._id),
    recetaItems: [SUERO],
    odontologiaNeurofocal: { observaciones: 'examen' },
  }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const media = await Appointment.findById(cita._id).lean();
  assert.equal(media.turns[0].status, 'completado', 'el turno del odontólogo debe cerrarse');
  assert.equal(media.currentTurnKind, 'enfermeria', 'ahora le toca a enfermería');
  assert.equal(media.currentTurnUser, null);
  assert.equal(media.status, 'asistida');
  assert.equal(media.serumStatus, 'por_asignar', 'la cita queda esperando el suero de mostrador');

  // Retenida: ni bandeja ni aviso de enfermería.
  assert.equal(
    (await bandeja(clinicId, enf._id, 'enfermero')).includes(String(cita._id)),
    false,
    'la cita NO sale en la bandeja del enfermero mientras falta el suero',
  );
  assert.equal(
    await Notification.countDocuments({ type: 'appointment_nursing', 'meta.appointment': cita._id }),
    0,
    'sin aviso para enfermería de una cita retenida',
  );

  // Mostrador asigna el suero DE LA FICHA (el recetado, o el que corresponda)
  // y la cita se libera a la bandeja.
  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const fuConSuero = rec.followUps.find((f) => (f.recetaItems || []).some((i) => i.isSerum));
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{
      kind: 'enfermeria',
      serviceName: 'Sueroterapia',
      serumFollowUp: String(fuConSuero._id),
      serum: { base: { name: 'Cloruro de sodio', volumeMl: 250 }, components: [{ name: 'Vitamina C', quantity: 1 }] },
    }],
  }, { params: { id: String(cita._id) } }));

  const liberada = await Appointment.findById(cita._id).lean();
  assert.equal(liberada.serumStatus, null, 'al asignar se libera');
  assert.equal(
    (await bandeja(clinicId, enf._id, 'enfermero')).includes(String(cita._id)),
    true,
    'la cita ya sale en la bandeja del enfermero',
  );
  assert.ok(
    await Notification.findOne({ type: 'appointment_nursing', 'meta.appointment': cita._id }).lean(),
    'el aviso llega una vez liberada la cita',
  );
});

test('odontologia_neurofocal receta suero sin turno de enfermería: el suero queda pendiente, SIN cita inventada', async () => {
  /**
   * Sep-2026, a petición de la clínica: el sistema NO crea citas de enfermería
   * automáticamente cuando quien receta es un doctor. Atendió desde su cita
   * asignada, guardó el seguimiento con la receta — y ahí se acaba: ninguna
   * cita extra en la agenda de nadie. El suero queda pendiente en la ficha y
   * ahí lo recoge quien reparte la atención: en «Asignar atención» la lista de
   * «Suero de la ficha» lo ofrece (ver `conReceta` en getOrCreateByPatient), y
   * por la puerta `by-appointment` la receta también sale al abrir la cita.
   */
  const { clinicId, userId, patient, odonto, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: odonto._id }],
  }, { params: { id: String(cita._id) } }));

  const r = await H.runController(records.addFollowUp, comoFicha(clinicId, odonto._id, patient._id, 'odontologia_neurofocal', {
    descripcion: 'Consulta con suero',
    appointmentId: String(cita._id),
    recetaItems: [SUERO],
  }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  // La cita de la consulta quedó cerrada…
  const media = await Appointment.findById(cita._id).lean();
  assert.equal(media.status, 'completada');

  // …y NO nació ninguna cita de enfermería automática.
  assert.equal(r.payload?.autoAppointment, undefined, 'no debe inventarse una cita para enfermería');
  const cuentas = await Appointment.countDocuments({ patient: patient._id });
  assert.equal(cuentas, 1, 'solo la cita original');

  // El suero sigue pendiente en la ficha: es lo que la lista de «Asignar
  // atención» ofrece para aplicarlo, con su sello de suero intacto.
  const rec = await ClinicalRecord.findOne({ patient: patient._id }).lean();
  const linea = (rec.followUps.find((f) => String(f._id) === String(media.turns[0].followUp))?.recetaItems || [])
    .find((i) => i.isSerum);
  assert.ok(linea, 'el suero queda escrito en la receta');
  assert.equal(linea.quantity, 1);
  assert.equal((linea.administrations || []).length, 0, 'todavía sin aplicar');
  assert.equal(
    await Notification.countDocuments({ type: 'appointment_nursing' }),
    0,
    'sin aviso de tarea que no existe',
  );
});

test('odontologia_neurofocal receta suero y detras hay turno de enfermeria: queda retenida, sin tarea duplicada', async () => {
  /**
   * Sep-2026: el sistema NO crea una cita de suero aparte, y TAMPOCO le entrega
   * la cita a enfermería con el suero del doctor dentro. Queda retenida
   * (`serumStatus='por_asignar'`) y sin aviso, hasta que mostrador asigne en
   * «Asignar atención».
   */
  const { clinicId, userId, patient, odonto, enf, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: odonto._id }, { kind: 'enfermeria', serviceName: 'Sueroterapia' }],
  }, { params: { id: String(cita._id) } }));

  const r = await H.runController(records.addFollowUp, comoFicha(clinicId, odonto._id, patient._id, 'odontologia_neurofocal', {
    descripcion: 'Consulta con suero',
    appointmentId: String(cita._id),
    recetaItems: [SUERO],
  }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  // La cita pasa a enfermería con el suero en su receta: NO hay tarea extra.
  assert.equal(r.payload?.autoAppointment, undefined, 'no debe crearse una cita de suero aparte');
  const cuentas = await Appointment.countDocuments({ patient: patient._id });
  assert.equal(cuentas, 1, 'solo la cita original');
  const media = await Appointment.findById(cita._id).lean();
  assert.equal(media.serumStatus, 'por_asignar', 'espera la decisión de mostrador');
  assert.equal(
    (await bandeja(clinicId, enf._id, 'enfermero')).includes(String(cita._id)),
    false,
    'retenida: no sale en la bandeja de enfermería',
  );
  assert.equal(
    await Notification.countDocuments({ type: 'appointment_nursing' }),
    0,
    'sin aviso de relevo mientras falta asignar el suero',
  );
});

test('la cita de otra sucursal del alcance TAMBIÉN avanza su turno al guardar', async () => {
  // La causa raíz del reporte: el odontólogo guarda con su token en otra sede
  // (la agenda de odontología le muestra la sucursal de odontología entera) y
  // el cierre del turno buscaba la cita SOLO en la sucursal activa: seguía
  // viva para siempre y la enfermera jamás la recibía.
  const { clinicId, userId, patient, odonto, enf, cita } = await seed();
  const otraSede = new (require('mongoose').Types.ObjectId)();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{
      kind: 'doctor',
      user: odonto._id,
    }, {
      kind: 'enfermeria',
      // Con el suero YA decidido: la retención (ver el test de abajo) no aplica,
      // y el aviso de relevo a enfermería es lo que este test mira.
      serum: { base: { name: 'Cloruro de sodio', volumeMl: 500 }, components: [{ name: 'Vitamina C', quantity: 1 }] },
    }],
  }, { params: { id: String(cita._id) } }));

  // Token en OTRA sucursal, pero el usuario tiene alcance a las dos.
  const req = H.mockReq(otraSede, odonto._id, {
    descripcion: 'Consulta con token en otra sede',
    appointmentId: String(cita._id),
  }, { role: 'odontologia_neurofocal', params: { patientId: String(patient._id) } });
  req.user = { _id: odonto._id, clinics: [{ clinic: clinicId }, { clinic: otraSede }] };

  const r = await H.runController(records.addFollowUp, req);
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const media = await Appointment.findById(cita._id).lean();
  assert.equal(media.turns[0].status, 'completado', 'el turno se cierra aunque el token esté en otra sede');
  assert.equal(media.currentTurnKind, 'enfermeria');
  assert.ok(
    await Notification.findOne({ type: 'appointment_nursing', 'meta.appointment': cita._id }).lean(),
    'el aviso va a la sucursal de la CITA',
  );
});

test('paso de enfermería SIN suero decidido y SIN receta en la ficha: la cita TAMBIÉN queda retenida', async () => {
  /**
   * FAUSTO MALLA UVACO, 18-sep-2026: la cita tenía doctor, doctor y un paso de
   * enfermería «SUERO TRAPIA» sin suero escogido. La ficha no tenía NINGUNA
   * receta de suero (el servicio no trae bolsa de serie), la primera regla de
   * retención —que exigía una receta pendiente— daba falso y la cita salió
   * sola a la bandeja de la enfermera. La decisión del suero es de mostrador
   * SIEMPRE que el paso no lo lleve escrito, haya o no receta previa.
   */
  const { clinicId, userId, patient, odonto, enf, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: odonto._id }, { kind: 'enfermeria', serviceName: 'SUERO TRAPIA' }],
  }, { params: { id: String(cita._id) } }));

  // El doctor guarda SIN recetar suero alguno.
  const r = await H.runController(records.addFollowUp, comoFicha(clinicId, odonto._id, patient._id, 'odontologia_neurofocal', {
    descripcion: 'Consulta sin receta de suero',
    appointmentId: String(cita._id),
  }));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const media = await Appointment.findById(cita._id).lean();
  assert.equal(media.turns[0].status, 'completado', 'el turno del doctor se cierra');
  assert.equal(media.currentTurnKind, 'enfermeria', 'le toca a enfermería, pero con la cita retenida');
  assert.equal(media.serumStatus, 'por_asignar', 'retiene aunque la ficha no tenga suero recetado');
  assert.equal(
    (await bandeja(clinicId, enf._id, 'enfermero')).includes(String(cita._id)),
    false,
    'la cita NO sale en la bandeja del enfermero sin decisión de mostrador',
  );
  assert.equal(
    await Notification.countDocuments({ type: 'appointment_nursing' }),
    0,
    'sin aviso a enfermería de una cita retenida',
  );

  // Mostrador reasigna el paso CON el suero y la cita se libera.
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{
      kind: 'enfermeria',
      serviceName: 'SUERO TRAPIA',
      serum: { base: { name: 'Cloruro de sodio', volumeMl: 500 }, components: [{ name: 'Vitamina C', quantity: 1 }] },
    }],
  }, { params: { id: String(cita._id) } }));

  const liberada = await Appointment.findById(cita._id).lean();
  assert.equal(liberada.serumStatus, null, 'al asignar el suero se libera');
  assert.equal(
    (await bandeja(clinicId, enf._id, 'enfermero')).includes(String(cita._id)),
    true,
    'con el suero decidido, la cita ya sale en la bandeja',
  );
});
