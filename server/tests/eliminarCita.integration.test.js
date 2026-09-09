/**
 * ELIMINAR UNA CITA (sep-2026, a petición de los usuarios).
 *
 * Dos reglas nuevas, y las dos salen del mismo malentendido: «eliminar» dejaba
 * la cita en estado 'cancelada' y ahí seguía —en el filtro «Todas», en la ficha,
 * en los listados—, así que quien la borraba volvía al rato a preguntar por qué
 * su cita no se había ido.
 *
 *   · ELIMINAR ES BORRAR: la cita desaparece de la base.
 *   · Y por eso mismo la papelera es de ADMINISTRACIÓN Y MARKETING: mostrador y
 *     call center, que agendan todo el día, ya no la tienen — lo que hacen ahora
 *     no se deshace.
 *
 * Lo que se vigila aquí es lo que un borrado de verdad se lleva por delante y lo
 * que NO puede llevarse: la cita cobrada (detrás hay una venta con su asiento) y
 * el suero ya aplicado (eso movió inventario).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const appt = require('../controllers/appointmentController');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const ClinicalRecord = require('../models/ClinicalRecord');
const Conversation = require('../models/Conversation');
const Sale = require('../models/Sale');
const AuditLog = require('../models/AuditLog');

const HOY = new Date();
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function seedCita(extra = {}) {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Vera' });
  const cita = await Appointment.create({
    clinic: clinicId,
    patient: patient._id,
    date: new Date(`${ymd(HOY)}T12:00:00`),
    startTime: '10:00',
    status: 'pendiente',
    createdBy: userId,
    ...extra,
  });
  return { clinicId, userId, patient, cita };
}

const req = (clinicId, userId, cita, role) =>
  H.mockReq(clinicId, userId, {}, { role, params: { id: String(cita._id) } });

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('mostrador y call center ya no eliminan citas', async () => {
  const { clinicId, userId, cita } = await seedCita();

  for (const role of ['cajero', 'call_center']) {
    // eslint-disable-next-line no-await-in-loop
    const r = await H.runController(appt.deleteAppointment, req(clinicId, userId, cita, role));
    assert.equal(r.statusCode, 403, `${role}: ${JSON.stringify(r.payload)}`);
    // eslint-disable-next-line no-await-in-loop
    assert.ok(await Appointment.findById(cita._id), `${role}: la cita sigue en la agenda`);
  }
});

test('marketing y administración la borran DE VERDAD (ya no queda «cancelada»)', async () => {
  for (const role of ['marketing', 'admin']) {
    // eslint-disable-next-line no-await-in-loop
    const { clinicId, userId, cita } = await seedCita();
    // eslint-disable-next-line no-await-in-loop
    const r = await H.runController(appt.deleteAppointment, req(clinicId, userId, cita, role));
    assert.equal(r.statusCode, 200, `${role}: ${JSON.stringify(r.payload)}`);
    // eslint-disable-next-line no-await-in-loop
    assert.equal(await Appointment.findById(cita._id), null, `${role}: la cita ya no existe`);

    // Si la cita ya no está, lo único que contesta «¿quién la borró?» es la
    // auditoría — y por eso lleva dentro una copia de la cita.
    // eslint-disable-next-line no-await-in-loop
    const apunte = await AuditLog.findOne({ entity: 'appointments', entityId: String(cita._id) });
    assert.ok(apunte, `${role}: el borrado queda en auditoría`);
    assert.equal(apunte.action, 'DELETE');
    assert.equal(String(apunte.before?.startTime), '10:00', 'la copia de la cita borrada');
  }
});

test('una cita YA COBRADA no se borra: primero se anula la venta', async () => {
  const { clinicId, userId, patient, cita } = await seedCita({ status: 'completada' });
  const venta = await Sale.create({
    clinic: clinicId,
    patient: patient._id,
    appointment: cita._id,
    items: [],
    taxAmount: 0,
    total: 30,
    subtotal: 30,
    paymentMethod: 'efectivo',
  });

  const r = await H.runController(appt.deleteAppointment, req(clinicId, userId, cita, 'admin'));
  assert.equal(r.statusCode, 409, JSON.stringify(r.payload));
  assert.ok(await Appointment.findById(cita._id), 'la cita cobrada sigue ahí');

  // Anulada la venta, la cita ya se puede borrar: el orden es ese.
  await Sale.updateOne({ _id: venta._id }, { $set: { status: 'anulada' } });
  const r2 = await H.runController(appt.deleteAppointment, req(clinicId, userId, cita, 'admin'));
  assert.equal(r2.statusCode, 200, JSON.stringify(r2.payload));
  assert.equal(await Appointment.findById(cita._id), null);
});

test('el suero que escribió la cita se va con ella; el ya aplicado se queda', async () => {
  const { clinicId, userId, patient, cita } = await seedCita();
  const record = await ClinicalRecord.create({
    clinic: clinicId,
    patient: patient._id,
    followUps: [
      { fecha: new Date(), recetaItems: [{ name: 'Suero de la cita', isSerum: true }] },
      {
        fecha: new Date(),
        recetaItems: [
          { name: 'Suero ya puesto', isSerum: true, administrations: [{ at: new Date() }] },
        ],
      },
    ],
  });
  const [pendiente, aplicado] = record.followUps;
  await Appointment.updateOne(
    { _id: cita._id },
    {
      $set: {
        autoSerumFollowUp: pendiente._id,
        turns: [{ kind: 'enfermeria', serumFollowUp: aplicado._id }],
      },
    }
  );

  const r = await H.runController(appt.deleteAppointment, req(clinicId, userId, cita, 'admin'));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await ClinicalRecord.findOne({ patient: patient._id });
  assert.equal(
    enBase.followUps.id(pendiente._id),
    null,
    'el suero pendiente de una cita borrada no puede quedarse como trabajo de enfermería'
  );
  assert.ok(
    enBase.followUps.id(aplicado._id),
    'lo que ya se le puso al paciente movió inventario: no se toca'
  );
});

test('la oportunidad del chat deja de apuntar a la cita borrada', async () => {
  const { clinicId, userId, cita } = await seedCita();
  const conv = await Conversation.create({
    clinic: clinicId,
    phone: '593999999999',
    opportunities: [{ stage: 'agendado', appointment: cita._id }],
  });

  const r = await H.runController(appt.deleteAppointment, req(clinicId, userId, cita, 'admin'));
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await Conversation.findById(conv._id);
  assert.equal(enBase.opportunities[0].appointment, null, 'sin cita a la que apuntar');
});
