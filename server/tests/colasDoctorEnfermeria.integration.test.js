/**
 * REPRODUCCIÓN del reporte de los enfermeros (sep-2026): cola
 * doctor → doctor → enfermería en la misma cita.
 *
 *  1. El doctor cierra su parte con «Finalizar consulta» (POST /end, no
 *     guardando seguimiento) y a la enfermera no le llega aviso ninguno: ni
 *     campana ni push. La cita le sale «Atendida» sin que nadie la haya
 *     pasado a su turno a voces.
 *  2. Un cajero que documenta un seguimiento sobre la cita ROBA el turno
 *     vigente (el de enfermería, abierto): la cita se completa a nombre del
 *     cajero y la enfermera nunca pudo tomarla.
 *  3. Una cita 'completada' con el turno de enfermería todavía pendiente
 *     sigue pudiendo ser reclamada y cerrada por la enfermera.
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
    clinic: clinicId, firstName: 'Belen', lastName: 'Loor', cedula: '0102030405',
  });

  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });

  const docA = await crear('DocA', 'doctor');
  const docB = await crear('DocB', 'doctor');
  const enf = await crear('EnfX', 'enfermero');
  const caja = await crear('CajaX', 'cajero');

  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });

  return { clinicId, userId, patient, docA, docB, enf, caja, cita };
}

const params = (id) => ({ params: { id: String(id) } });
const como = (clinicId, userId, id, role, body = {}) =>
  H.mockReq(clinicId, userId, body, { role, ...params(id) });
const comoFicha = (clinicId, userId, patientId, role, body = {}) =>
  H.mockReq(clinicId, userId, body, { role, params: { patientId: String(patientId) } });

/** Ids de las citas que la bandeja de ESTE usuario devuelve. */
async function bandeja(clinicId, userId, role) {
  const r = await H.runController(
    appt.getAppointments,
    H.mockReq(clinicId, userId, {}, { role, query: {} }),
  );
  const lista = Array.isArray(r.payload) ? r.payload : r.payload?.appointments || [];
  return lista.map((a) => String(a._id));
}

const avisoDeEnfermeria = (citaId) =>
  Notification.findOne({ type: 'appointment_nursing', 'meta.appointment': citaId }).lean();

test('doctores cierran con «Finalizar consulta» y la cita queda pendiente para enfermería, con aviso', async () => {
  const { clinicId, userId, docA, docB, enf, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: docA._id }, { kind: 'doctor', user: docB._id }, { kind: 'enfermeria' }],
  }, params(cita._id)));

  // Cada doctor cierra su parte por el botón «Finalizar consulta».
  const finA = await H.runController(appt.endConsultation, como(clinicId, docA._id, cita._id, 'doctor'));
  assert.equal(finA.statusCode < 400, true, JSON.stringify(finA.payload));
  const finB = await H.runController(appt.endConsultation, como(clinicId, docB._id, cita._id, 'doctor'));
  assert.equal(finB.statusCode < 400, true, JSON.stringify(finB.payload));

  const media = await Appointment.findById(cita._id).lean();
  assert.equal(media.turns[0].status, 'completado');
  assert.equal(media.turns[1].status, 'completado');
  assert.equal(media.currentTurnKind, 'enfermeria', 'ahora le toca a enfermería');
  assert.equal(media.currentTurnUser, null, 'turno abierto: lo toma quien pueda');
  assert.equal(media.status, 'asistida', 'la cita sigue viva para enfermería');

  // En la bandeja de la enfermera debe estar como pendiente.
  assert.equal(
    (await bandeja(clinicId, enf._id, 'enfermero')).includes(String(cita._id)),
    true,
    'la cita debe salir en la bandeja del enfermero',
  );

  // Y debe haberle llegado el aviso: ni socket ni campana se enteraban antes.
  assert.ok(await avisoDeEnfermeria(cita._id), 'debe existir el aviso appointment_nursing');
});

test('el cajero que documenta un seguimiento NO roba el turno de enfermería', async () => {
  const { clinicId, userId, docA, enf, caja, cita, patient } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: docA._id }, { kind: 'enfermeria' }],
  }, params(cita._id)));

  // El doctor escribe su consulta: su turno se cierra y la cita pasa a enfermería.
  const fu1 = await H.runController(records.addFollowUp, comoFicha(clinicId, docA._id, patient._id, 'doctor', {
    descripcion: 'Consulta del doctor',
    appointmentId: String(cita._id),
  }));
  assert.equal(fu1.statusCode < 400, true, JSON.stringify(fu1.payload));

  // El cajero documenta por otro (acuerdo de pago, venta…) sobre la MISMA cita:
  // su seguimiento se guarda, pero NO puede cerrarle el turno a nadie.
  const fu2 = await H.runController(records.addFollowUp, comoFicha(clinicId, caja._id, patient._id, 'cajero', {
    descripcion: 'Documento por mostrador',
    appointmentId: String(cita._id),
  }));
  assert.equal(fu2.statusCode < 400, true, JSON.stringify(fu2.payload));

  const media = await Appointment.findById(cita._id).lean();
  assert.equal(media.turns[0].status, 'completado');
  assert.equal(media.turns[1].status, 'pendiente', 'el turno de enfermería NO fue robado');
  assert.equal(media.currentTurnKind, 'enfermeria');
  assert.equal(media.currentTurnUser, null, 'sigue libre para cualquier enfermero');
  assert.equal(media.status, 'asistida', 'la cita sigue esperando a enfermería');

  // Y la enfermera puede atenderla y cerrarla sin trabas.
  const reclamo = await H.runController(appt.nurseClaim, como(clinicId, enf._id, cita._id, 'enfermero'));
  assert.equal(reclamo.statusCode < 400, true, JSON.stringify(reclamo.payload));
  const fin = await H.runController(appt.nurseComplete, como(clinicId, enf._id, cita._id, 'enfermero'));
  assert.equal(fin.statusCode < 400, true, JSON.stringify(fin.payload));
  const cierre = await Appointment.findById(cita._id).lean();
  assert.equal(cierre.status, 'completada');
  assert.equal(String(cierre.turns[1].user), String(enf._id));
});

test('una cita completada con turno de enfermería pendiente la cierra igual la enfermera', async () => {
  const { clinicId, userId, enf, cita } = await seed();

  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'enfermeria' }],
  }, params(cita._id)));

  // Estado trabado: completada con un turno pendiente (p.ej. un cambio de
  // estado a mano desde el mostrador).
  await Appointment.updateOne({ _id: cita._id }, { $set: { status: 'completada' } });

  // La sigue viendo y puede recuperarla: reclama y termina.
  assert.equal(
    (await bandeja(clinicId, enf._id, 'enfermero')).includes(String(cita._id)),
    true,
    'la cita debe verse en la bandeja aunque esté completada',
  );
  const reclamo = await H.runController(appt.nurseClaim, como(clinicId, enf._id, cita._id, 'enfermero'));
  assert.equal(reclamo.statusCode < 400, true, JSON.stringify(reclamo.payload));
  const fin = await H.runController(appt.nurseComplete, como(clinicId, enf._id, cita._id, 'enfermero'));
  assert.equal(fin.statusCode < 400, true, JSON.stringify(fin.payload));
  const cierre = await Appointment.findById(cita._id).lean();
  assert.equal(cierre.turns[0].status, 'completado');
  assert.equal(cierre.status, 'completada');
});
