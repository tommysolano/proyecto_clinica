/**
 * QUIÉN VE QUÉ EN LA AGENDA (sep-2026, cuatro pedidos de la clínica).
 *
 *  1. El doctor escogido AL AGENDAR no ve la cita mientras esté pendiente: le
 *     aparece cuando mostrador le da a «Asignar atención».
 *  2. Odontología es COMPARTIDA: la cita de un odontólogo sale en la agenda de
 *     todos los odontólogos, y cualquiera puede entrar a atenderla.
 *  3. Enfermería, al atender, solo ve lo que asignó mostrador — no la consulta
 *     ni la receta del doctor que la atendió antes en la misma cita.
 *  4. «Mis datos»: cada usuario edita su nombre, cédula y teléfono.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const appt = require('../controllers/appointmentController');
const records = require('../controllers/clinicalRecordController');
const auth = require('../controllers/authController');
const { asignarTurnos } = require('../utils/appointmentTurns');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });
  const crear = (name, role) => User.create({
    name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
    clinics: [{ clinic: clinicId, role }],
  });
  const doc = await crear('Doc', 'doctor');
  const odoA = await crear('OdoA', 'odontologia');
  const odoB = await crear('OdoB', 'odontologia');
  const enf = await crear('Enf', 'enfermero');
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '10:00', status: 'pendiente',
  });
  return { clinicId, userId, patient, doc, odoA, odoB, enf, cita };
}

const params = (id) => ({ params: { id: String(id) } });

const agendaDe = async (clinicId, user, role) => {
  const r = await H.runController(appt.getAppointments, H.mockReq(clinicId, user._id, {}, { role, query: {} }));
  const lista = Array.isArray(r.payload) ? r.payload : [];
  return lista;
};

/** Como queda la cita cuando se agenda con el doctor ya escogido. */
async function agendarCon(cita, userId) {
  const a = await Appointment.findById(cita._id);
  asignarTurnos(a, { pasos: [{ kind: 'doctor', user: userId }] });
  await a.save();
}

test('1 · el doctor escogido al agendar NO ve la cita pendiente; la ve al asignar la atención', async () => {
  const { clinicId, userId, doc, cita } = await seed();
  await agendarCon(cita, doc._id);

  assert.deepEqual((await agendaDe(clinicId, doc, 'doctor')).map((a) => String(a._id)), [],
    'pendiente: todavía no es suya');

  const r = await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: String(doc._id) }],
  }, params(cita._id)));
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(cita._id).lean();
  assert.ok(guardada.attentionAssignedAt, 'queda la marca de «Asignar atención»');
  assert.deepEqual((await agendaDe(clinicId, doc, 'doctor')).map((a) => String(a._id)), [String(cita._id)],
    'asignada: ahora sí le aparece');
});

test('1b · una cita de OTRO DÍA asignada también le aparece, aunque siga pendiente', async () => {
  const { clinicId, userId, doc, patient } = await seed();
  const manana = new Date(H.docDate());
  manana.setDate(manana.getDate() + 1);
  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: manana, startTime: '10:00', status: 'pendiente',
  });
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: String(doc._id) }],
  }, params(cita._id)));
  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(guardada.status, 'pendiente', 'asignar mañana no la da por asistida');
  assert.deepEqual((await agendaDe(clinicId, doc, 'doctor')).map((a) => String(a._id)), [String(cita._id)]);
});

test('2 · la cita de un odontólogo la ven TODOS los odontólogos, y cualquiera la puede iniciar', async () => {
  const { clinicId, userId, odoA, odoB, doc, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: String(odoA._id) }],
  }, params(cita._id)));

  const deB = await agendaDe(clinicId, odoB, 'odontologia');
  assert.deepEqual(deB.map((a) => String(a._id)), [String(cita._id)], 'OdoB ve la cita de OdoA');
  assert.equal(deB[0].turnoOdontologiaCompartido, true, 'y la pantalla sabe que puede atenderla');

  // Los demás médicos siguen viendo solo lo suyo.
  assert.deepEqual((await agendaDe(clinicId, doc, 'doctor')).map((a) => String(a._id)), []);

  const start = await H.runController(appt.startConsultation, H.mockReq(clinicId, odoB._id, {}, {
    role: 'odontologia', ...params(cita._id),
  }));
  assert.equal(start.statusCode < 400, true, JSON.stringify(start.payload));

  // El turno no cambia de dueño: la cita sigue a nombre de OdoA.
  const guardada = await Appointment.findById(cita._id).lean();
  assert.equal(String(guardada.doctor), String(odoA._id));
});

test('2b · odontología sigue viendo sus citas PENDIENTES (agenda y atiende directo)', async () => {
  const { clinicId, odoA, odoB, cita } = await seed();
  await agendarCon(cita, odoA._id);
  assert.deepEqual((await agendaDe(clinicId, odoB, 'odontologia')).map((a) => String(a._id)), [String(cita._id)]);
});

test('2c · odontología ve TODAS las citas de la sucursal «odontología», y en las demás solo las de odontólogos', async () => {
  const { clinicId, odoA, odoB, doc, cita, patient } = await seed();
  const Clinic = require('../models/Clinic');
  const sedeOdonto = await Clinic.create({ name: 'odontología' });
  await Clinic.create({ _id: clinicId, name: 'Central' });

  // En la sucursal de odontología, agendadas por caja: sin doctor y con otro doctor.
  const sinDoctor = await Appointment.create({
    clinic: sedeOdonto._id, patient: patient._id, date: H.docDate(), startTime: '09:00', status: 'pendiente',
  });
  const conOtro = await Appointment.create({
    clinic: sedeOdonto._id, patient: patient._id, date: H.docDate(), startTime: '11:00', status: 'pendiente',
  });
  await agendarCon(conOtro, doc._id);
  // En Central: la de un odontólogo sí; `cita` (sin doctor) NO.
  const deOdontologoEnCentral = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: H.docDate(), startTime: '12:00', status: 'pendiente',
  });
  await agendarCon(deOdontologoEnCentral, odoA._id);

  // Como en producción: trabaja en todas las sucursales y la agenda pide clinic=all.
  const r = await H.runController(appt.getAppointments, (() => {
    const req = H.mockReq(clinicId, odoB._id, {}, { role: 'odontologia', query: { clinic: 'all' } });
    req.user.worksInAllClinics = true;
    return req;
  })());
  const ids = r.payload.map((a) => String(a._id)).sort();
  assert.deepEqual(ids, [String(sinDoctor._id), String(conOtro._id), String(deOdontologoEnCentral._id)].sort());
  assert.ok(!ids.includes(String(cita._id)), 'la cita sin doctor de Central no es de odontología');
  // El doctor general sigue sin ver la pendiente.
  assert.deepEqual((await agendaDe(clinicId, doc, 'doctor')).map((a) => String(a._id)), []);
});

test('3 · enfermería NO ve la consulta del doctor de la misma cita, solo el suero de mostrador', async () => {
  const { clinicId, userId, patient, doc, enf, cita } = await seed();
  await H.runController(appt.assignDoctor, H.mockReq(clinicId, userId, {
    steps: [{ kind: 'doctor', user: String(doc._id) }, { kind: 'enfermeria', nurseInstructions: 'Tomar signos' }],
  }, params(cita._id)));

  // El doctor atiende y receta un suero.
  const fuDoc = await H.runController(records.addFollowUp, H.mockReq(clinicId, doc._id, {
    descripcion: 'Consulta', appointmentId: String(cita._id),
    recetaItems: [{
      name: 'SUERO DEL DOCTOR', quantity: 1, isSerum: true,
      serumBase: { name: 'Cloruro', volumeMl: 250 },
      serumComponents: [{ name: 'VITAMINA C', quantity: 1 }],
    }],
  }, { role: 'doctor', params: { patientId: String(patient._id) } }));
  assert.equal(fuDoc.statusCode < 400, true, JSON.stringify(fuDoc.payload));

  const vista = await H.runController(records.getFollowUpsByAppointment, H.mockReq(clinicId, enf._id, {}, {
    role: 'enfermero', params: { appointmentId: String(cita._id) },
  }));
  assert.equal(vista.statusCode, 200, JSON.stringify(vista.payload));
  const nombres = vista.payload.followUps.flatMap((f) => (f.recetaItems || []).map((i) => i.name));
  assert.ok(!nombres.includes('SUERO DEL DOCTOR'), 'lo recetado por el doctor no le llega');

  // Mostrador sí lo ve (y quien administra), por la misma puerta.
  const deCaja = await H.runController(records.getFollowUpsByAppointment, H.mockReq(clinicId, userId, {}, {
    role: 'cajero', params: { appointmentId: String(cita._id) },
  }));
  assert.ok(deCaja.payload.followUps.some((f) => (f.recetaItems || []).some((i) => i.name === 'SUERO DEL DOCTOR')));
});

test('4 · «Mis datos»: nombre, cédula y teléfono, con la cédula comprobada', async () => {
  const { clinicId, enf } = await seed();
  const req = (body) => H.mockReq(clinicId, enf._id, body, { role: 'enfermero' });

  const mala = await H.runController(auth.updateProfile, req({ name: 'Enf', cedula: '0102030401' }));
  assert.equal(mala.statusCode, 400, 'un dígito cambiado no pasa');

  const vacia = await H.runController(auth.updateProfile, req({ name: '  ' }));
  assert.equal(vacia.statusCode, 400);

  const ok = await H.runController(auth.updateProfile, req({
    name: 'María  Pérez', cedula: '0102030400', phone: '0991234567',
  }));
  assert.equal(ok.statusCode < 400, true, JSON.stringify(ok.payload));
  const u = await User.findById(enf._id).lean();
  assert.equal(u.name, 'María Pérez');
  assert.equal(u.cedula, '0102030400');
  assert.equal(u.phone, '0991234567');
  assert.equal(u.clinics[0].role, 'enfermero', 'no toca nada más');
});
