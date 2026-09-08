/**
 * «ESTA CITA LA CERRÓ MI COMPAÑERA, YO SOLO LA ESCRIBÍ» (7-sep-2026).
 *
 * En el call center las citas se cierran en pareja: una asesora habla con el
 * paciente y otra la digita —porque la primera sigue en llamada, o porque el
 * turno cambió a media conversación—. La cita se apuntaba SIEMPRE a quien
 * teclea, y con ella el reporte de citas por asesor y el panel de supervisión,
 * que es justo para lo que se mira ese dato.
 *
 * Lo que fijan estos tests:
 *   1. `bookedBy` acredita la cita a otra persona, y deja constancia de quién la
 *      escribió (`registeredBy`), que es lo que impide que esto sea firmar por otro;
 *   2. no vale acreditar a cualquiera: tiene que ser alguien que agende;
 *   3. quien no agenda no puede usarlo;
 *   4. y CÓMO se pagó el adelanto se guarda con el resto del valor de la cita.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const User = require('../models/User');
const appt = require('../controllers/appointmentController');
const users = require('../controllers/userController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
  });
  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });
  const sofia = await crear('Sofia', 'call_center');   // la que cierra la cita
  const jaime = await crear('Jaime', 'call_center');   // el que la escribe
  const doc = await crear('DocA', 'doctor');           // no agenda
  return { clinicId, userId, patient, sofia, jaime, doc };
}

/**
 * MAÑANA, no hoy: agendar HOY a las 10:00 lo rechaza la validación de hora
 * pasada en cuanto son las 10:01 en Ecuador, así que estos seis tests solo
 * pasaban si la suite se corría a primera hora de la mañana. Lo que se está
 * probando es a nombre de quién queda la cita, no qué día es.
 */
const manana = () => {
  const d = H.docDate();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
};

const cuerpoCita = (patient, extra = {}) => ({
  patient: String(patient._id),
  date: manana(),
  startTime: '10:00',
  ...extra,
});

test('la cita se acredita a quien la cerró, y consta quién la escribió', async () => {
  const { clinicId, patient, sofia, jaime } = await seed();

  const req = H.mockReq(clinicId, jaime._id, cuerpoCita(patient, { bookedBy: String(sofia._id) }), {
    role: 'call_center',
  });
  // En producción `req.user` es el usuario entero (lo pone `auth`); el arnés solo
  // pone el id, y el nombre es justo lo que se guarda de sello.
  req.user.name = 'Jaime';
  const r = await H.runController(appt.createAppointment, req);
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const cita = await Appointment.findById(r.payload._id);
  assert.equal(String(cita.createdBy), String(sofia._id), 'la cita es de Sofia');
  assert.equal(cita.createdByName, 'Sofia');
  assert.equal(cita.createdByRole, 'call_center');
  assert.equal(String(cita.registeredBy), String(jaime._id), 'y la escribió Jaime');
  assert.equal(cita.registeredByName, 'Jaime');
});

test('sin `bookedBy` todo sigue igual: la cita es de quien la escribe', async () => {
  const { clinicId, patient, jaime } = await seed();

  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, jaime._id, cuerpoCita(patient), { role: 'call_center' })
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const cita = await Appointment.findById(r.payload._id);
  assert.equal(String(cita.createdBy), String(jaime._id));
  assert.equal(cita.registeredBy, null, 'sin nadie más de por medio, no hay «escrita por»');
  assert.equal(cita.registeredByName, '');
});

test('no se acredita a quien no agenda (un doctor no cierra citas por teléfono)', async () => {
  const { clinicId, patient, jaime, doc } = await seed();

  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, jaime._id, cuerpoCita(patient, { bookedBy: String(doc._id) }), {
      role: 'call_center',
    })
  );
  assert.equal(r.statusCode, 400, JSON.stringify(r.payload));
  assert.equal(await Appointment.countDocuments({}), 0, 'y no se crea la cita a medias');
});

test('quien no agenda tampoco puede acreditar la cita a otro', async () => {
  const { clinicId, patient, sofia, doc } = await seed();

  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, doc._id, cuerpoCita(patient, { bookedBy: String(sofia._id) }), {
      role: 'doctor',
    })
  );
  assert.equal(r.statusCode, 403, JSON.stringify(r.payload));
});

test('el selector de «agendada por» ofrece a quien agenda, no a quien atiende', async () => {
  const { clinicId, sofia, jaime, doc } = await seed();

  const r = await H.runController(
    users.getSchedulers,
    H.mockReq(clinicId, jaime._id, {}, { role: 'call_center' })
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  const nombres = r.payload.map((u) => u.name).sort();
  assert.deepEqual(nombres, ['Jaime', 'Sofia']);
  assert.equal(r.payload.find((u) => u.name === 'Sofia').role, 'call_center');
  assert.equal(r.payload.some((u) => String(u._id) === String(doc._id)), false);
});

// ─────────────────── Cómo pagó el adelanto ───────────────────

test('el adelanto guarda CON QUÉ se pagó', async () => {
  const { clinicId, patient, jaime } = await seed();

  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, jaime._id, cuerpoCita(patient, {
      agreedValue: 80,
      advancePayment: 'abono',
      advanceAmount: 20,
      advanceMethod: 'transferencia',
    }), { role: 'call_center' })
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const cita = await Appointment.findById(r.payload._id);
  assert.equal(cita.advancePayment, 'abono');
  assert.equal(cita.advanceAmount, 20);
  assert.equal(cita.advanceMethod, 'transferencia');
});

test('sin adelanto no queda forma de pago colgando', async () => {
  const { clinicId, patient, jaime } = await seed();

  const creada = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, jaime._id, cuerpoCita(patient, {
      agreedValue: 80, advancePayment: 'total', advanceMethod: 'efectivo',
    }), { role: 'call_center' })
  );
  assert.equal(creada.statusCode < 400, true, JSON.stringify(creada.payload));
  assert.equal((await Appointment.findById(creada.payload._id)).advanceMethod, 'efectivo');

  // Se corrige: al final no había pagado nada.
  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(clinicId, jaime._id, { advancePayment: '', advanceMethod: 'efectivo' }, {
      role: 'call_center', params: { id: String(creada.payload._id) },
    })
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const cita = await Appointment.findById(creada.payload._id);
  assert.equal(cita.advancePayment, '');
  assert.equal(cita.advanceAmount, 0);
  assert.equal(cita.advanceMethod, '', 'no se queda «efectivo» en una cita que no cobró nada');
});

test('una forma de pago inventada no se guarda', async () => {
  const { clinicId, patient, jaime } = await seed();
  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, jaime._id, cuerpoCita(patient, {
      agreedValue: 50, advancePayment: 'total', advanceMethod: 'criptomonedas',
    }), { role: 'call_center' })
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));
  assert.equal((await Appointment.findById(r.payload._id)).advanceMethod, '');
});
