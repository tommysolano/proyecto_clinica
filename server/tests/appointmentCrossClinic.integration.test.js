/**
 * CITAS DE OTRA SUCURSAL: verlas y poder tocarlas tiene que ser lo mismo.
 *
 * El caso real (3-sep-2026): un cajero de Shiluv agendó una cita con «sucursal
 * destino» = extension, la vio en su agenda —la de mostrador es de toda la
 * organización— y al asignar al doctor le salió «Cita no encontrada». La cita
 * existía: la lectura miraba todas las sucursales y la escritura solo la activa
 * (`clinic: req.clinicId`).
 *
 * Se vigila que TODAS las puertas que operan una cita usen el mismo alcance que
 * el listado (`filtroSucursalCita`), y que lo que dependa de la sucursal después
 * de encontrarla salga de la CITA y no de la sucursal activa de quien pulsa.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');

const appt = require('../controllers/appointmentController');
const users = require('../controllers/userController');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const User = require('../models/User');
const Clinic = require('../models/Clinic');

const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/**
 * Dos sucursales. El cajero está asignado SOLO a la propia (así se reprodujo el
 * error: su usuario tenía Shiluv y la cita era de extension) y la cita vive en
 * la otra.
 */
async function seedDosSedes({ status = 'pendiente', date = new Date() } = {}) {
  const { clinicId: sedeCajero, userId } = await H.seedClinic();
  const otraSede = await Clinic.create({ name: 'extension', ruc: `9${Date.now()}`.slice(0, 13) });
  const patient = await Patient.create({
    clinic: otraSede._id,
    firstName: 'MARIA AUXILIADORA',
    lastName: 'VERA VASQUEZ',
  });
  const doctorDeLaOtraSede = await User.create({
    name: 'Doc Extension',
    email: `ext${Date.now()}@t.com`,
    password: 'secret123',
    clinics: [{ clinic: otraSede._id, role: 'doctor' }],
  });
  const doctorDeMiSede = await User.create({
    name: 'Doc Shiluv',
    email: `shi${Date.now()}@t.com`,
    password: 'secret123',
    clinics: [{ clinic: sedeCajero, role: 'doctor' }],
  });
  const cita = await Appointment.create({
    clinic: otraSede._id,
    patient: patient._id,
    date: new Date(`${ymd(date)}T12:00:00`),
    startTime: '10:20',
    status,
    createdBy: userId,
    createdByRole: 'cajero',
  });
  return { sedeCajero, otraSede, userId, cita, doctorDeLaOtraSede, doctorDeMiSede, patient };
}

// El cajero de una sola sede: exactamente el usuario del reporte.
const reqCajero = (sedeCajero, userId, body = {}, extra = {}) => {
  const req = H.mockReq(sedeCajero, userId, body, { role: 'cajero', ...extra });
  req.user.clinics = [{ clinic: sedeCajero, role: 'cajero' }];
  return req;
};

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('el cajero asigna el doctor de una cita de otra sucursal (era «Cita no encontrada»)', async () => {
  const { sedeCajero, otraSede, userId, cita, doctorDeLaOtraSede } = await seedDosSedes();

  const r = await H.runController(
    appt.assignDoctor,
    reqCajero(
      sedeCajero,
      userId,
      { steps: [{ kind: 'doctor', user: String(doctorDeLaOtraSede._id) }] },
      { params: { id: String(cita._id) } }
    )
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal(String(r.payload.doctor?._id || r.payload.doctor), String(doctorDeLaOtraSede._id));

  const enBase = await Appointment.findById(cita._id);
  assert.equal(String(enBase.clinic), String(otraSede._id), 'la cita NO cambia de sucursal al asignarla');
  assert.equal(enBase.status, 'asistida', 'asignar da por recibido al paciente');
});

test('la cita ya marcada ausente por el reloj se corrige al asignar al doctor', async () => {
  // Es lo que le pasó a la cita del reporte: mientras peleaban con el error,
  // `autoNoShow` la marcó 'no_asistio'.
  const { sedeCajero, userId, cita, doctorDeLaOtraSede } = await seedDosSedes({ status: 'no_asistio' });

  const r = await H.runController(
    appt.assignDoctor,
    reqCajero(
      sedeCajero,
      userId,
      { steps: [{ kind: 'doctor', user: String(doctorDeLaOtraSede._id) }] },
      { params: { id: String(cita._id) } }
    )
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  assert.equal((await Appointment.findById(cita._id)).status, 'asistida');
});

test('una cita cancelada a mano NO revive al asignar', async () => {
  const { sedeCajero, userId, cita, doctorDeLaOtraSede } = await seedDosSedes({ status: 'cancelada' });

  await H.runController(
    appt.assignDoctor,
    reqCajero(
      sedeCajero,
      userId,
      { steps: [{ kind: 'doctor', user: String(doctorDeLaOtraSede._id) }] },
      { params: { id: String(cita._id) } }
    )
  );
  assert.equal((await Appointment.findById(cita._id)).status, 'cancelada');
});

test('no se puede asignar a un doctor que no atiende en la sucursal de la cita', async () => {
  const { sedeCajero, userId, cita, doctorDeMiSede } = await seedDosSedes();

  const r = await H.runController(
    appt.assignDoctor,
    reqCajero(
      sedeCajero,
      userId,
      { steps: [{ kind: 'doctor', user: String(doctorDeMiSede._id) }] },
      { params: { id: String(cita._id) } }
    )
  );
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.match(r.payload.message, /no atiende en la sucursal/i);
  assert.equal((await Appointment.findById(cita._id)).doctor, null);
});

test('el selector de personal trae el de la sucursal que se le pide', async () => {
  const { sedeCajero, otraSede, userId, doctorDeLaOtraSede, doctorDeMiSede } = await seedDosSedes();

  const propia = await H.runController(users.getDoctors, reqCajero(sedeCajero, userId));
  assert.deepEqual(
    propia.payload.map((d) => String(d._id)),
    [String(doctorDeMiSede._id)]
  );

  const ajena = await H.runController(
    users.getDoctors,
    reqCajero(sedeCajero, userId, {}, { query: { clinic: String(otraSede._id) } })
  );
  assert.deepEqual(
    ajena.payload.map((d) => String(d._id)),
    [String(doctorDeLaOtraSede._id)],
    'sin esto el modal ofrecía a los doctores de la sede equivocada'
  );
  assert.equal(ajena.payload[0].roleInClinic, 'doctor', 'el tipo de doctor sale de su rol EN ESA sede');
});

test('el resto de botones de la cita también dejan de dar 404', async () => {
  const { sedeCajero, userId, cita } = await seedDosSedes();

  const confirmar = await H.runController(
    appt.markConfirmed,
    reqCajero(sedeCajero, userId, {}, { params: { id: String(cita._id) } })
  );
  assert.equal(confirmar.statusCode, 200, JSON.stringify(confirmar.payload));

  const ausente = await H.runController(
    appt.markNoShow,
    reqCajero(sedeCajero, userId, {}, { params: { id: String(cita._id) } })
  );
  assert.equal(ausente.statusCode, 200, JSON.stringify(ausente.payload));

  const valor = await H.runController(
    appt.updateServiceAndValue,
    reqCajero(sedeCajero, userId, { agreedValue: 30 }, { params: { id: String(cita._id) } })
  );
  assert.equal(valor.statusCode, 200, JSON.stringify(valor.payload));
  assert.equal((await Appointment.findById(cita._id)).agreedValue, 30);

  const editar = await H.runController(
    appt.updateAppointment,
    reqCajero(sedeCajero, userId, { reason: 'control' }, { params: { id: String(cita._id) } })
  );
  assert.equal(editar.statusCode, 200, JSON.stringify(editar.payload));

  const cancelar = await H.runController(
    appt.deleteAppointment,
    reqCajero(sedeCajero, userId, {}, { params: { id: String(cita._id) } })
  );
  assert.equal(cancelar.statusCode, 200, JSON.stringify(cancelar.payload));
  assert.equal((await Appointment.findById(cita._id)).status, 'cancelada');
});

test('quien NO ve toda la organización sigue sin poder tocar la cita de otra sede', async () => {
  const { sedeCajero, userId, cita } = await seedDosSedes();

  // Un doctor solo llega a las sucursales que tiene asignadas.
  const req = H.mockReq(sedeCajero, userId, {}, { role: 'doctor', params: { id: String(cita._id) } });
  req.user.clinics = [{ clinic: sedeCajero, role: 'doctor' }];
  const r = await H.runController(appt.startConsultation, req);
  assert.equal(r.statusCode, 404, 'la cita de otra sucursal no es suya');

  // Y con la sucursal asignada, sí.
  const req2 = H.mockReq(sedeCajero, userId, {}, { role: 'doctor', params: { id: String(cita._id) } });
  req2.user.clinics = [
    { clinic: sedeCajero, role: 'cajero' },
    { clinic: cita.clinic, role: 'doctor' },
  ];
  const r2 = await H.runController(appt.startConsultation, req2);
  assert.notEqual(r2.statusCode, 404, JSON.stringify(r2.payload));
});

test('una cita inexistente sigue devolviendo 404 y no revienta', async () => {
  const { sedeCajero, userId } = await seedDosSedes();
  const r = await H.runController(
    appt.assignDoctor,
    reqCajero(
      sedeCajero,
      userId,
      { steps: [{ kind: 'enfermeria', user: null, serviceName: 'Signos' }] },
      { params: { id: String(new mongoose.Types.ObjectId()) } }
    )
  );
  assert.equal(r.statusCode, 404);
});
