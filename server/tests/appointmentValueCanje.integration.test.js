/**
 * VALOR DE LA CITA Y CANJE, y la corrección del servicio después de atender.
 *
 * Lo que se prueba aquí es la separación entre lo OPERATIVO y lo contable: el
 * valor es lo que se acordó que va a pagar el paciente, se anota en la agenda y
 * no genera venta, factura ni cobro. Y las tres reglas que lo gobiernan:
 *
 *   · lo pone mostrador (admin/cajero) y NADIE más, ni siquiera enfermería, que
 *     también puede asignar la atención;
 *   · canje y valor son excluyentes: marcar canje deja el importe en 0;
 *   · el servicio y el valor se pueden corregir con la cita YA COMPLETADA, que
 *     es justo cuando se sabe qué se hizo de verdad — pero sin que eso abra la
 *     puerta a cambiar quién atendió.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const appt = require('../controllers/appointmentController');
const Patient = require('../models/Patient');
const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const User = require('../models/User');

const HOY = new Date();
const ymd = (d) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function seedCase() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });
  const doc = await User.create({
    clinic: clinicId, name: 'DocA', email: `doc${Date.now()}@t.com`, password: 'secret123', role: 'doctor',
  });
  const servicio = (name) =>
    AppointmentServiceItem.create({
      clinic: clinicId,
      name,
      slug: AppointmentServiceItem.slugify(name),
    });
  const consulta = await servicio('Consulta');
  const botox = await servicio('Botox');
  const make = (extra = {}) =>
    Appointment.create({
      clinic: clinicId,
      patient: patient._id,
      date: new Date(`${ymd(HOY)}T12:00:00`),
      startTime: '10:00',
      status: 'pendiente',
      serviceItem: consulta._id,
      serviceName: 'Consulta',
      createdBy: userId,
      ...extra,
    });
  return { clinicId, userId, doc, consulta, botox, make };
}

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// ─────────────────────────────────────────────────────────────────────────────
test('al recibir al paciente, caja anota el valor de la cita', async () => {
  const { clinicId, userId, doc, make } = await seedCase();
  const apt = await make();

  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(
      clinicId, userId,
      { steps: [{ kind: 'doctor', user: String(doc._id) }], agreedValue: 45.5, isCanje: false },
      { role: 'cajero', params: { id: String(apt._id) } }
    )
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.agreedValue, 45.5);
  assert.equal(enBase.isCanje, false);
  assert.equal(enBase.status, 'asistida', 'asignar da la cita por asistida');
  assert.ok(enBase.valueSetAt, 'queda registrado cuándo se fijó');
  assert.equal(String(enBase.valueSetBy), String(userId), 'y quién lo fijó');
});

test('el canje deja el importe en 0: no entró dinero', async () => {
  const { clinicId, userId, doc, make } = await seedCase();
  const apt = await make();

  await H.runController(
    appt.assignDoctor,
    H.mockReq(
      clinicId, userId,
      // Aunque venga un importe: el canje manda.
      { steps: [{ kind: 'doctor', user: String(doc._id) }], agreedValue: 80, isCanje: true },
      { role: 'cajero', params: { id: String(apt._id) } }
    )
  );

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.isCanje, true);
  assert.equal(enBase.agreedValue, 0, 'un canje con importe se contaría dos veces al sumar lo cobrado');
});

test('enfermería asigna la atención pero NO pone el valor', async () => {
  const { clinicId, userId, doc, make } = await seedCase();
  const apt = await make();

  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(
      clinicId, userId,
      { steps: [{ kind: 'doctor', user: String(doc._id) }], agreedValue: 999, isCanje: true },
      { role: 'enfermero', params: { id: String(apt._id) } }
    )
  );
  assert.equal(r.statusCode, 200, 'la asignación en sí sí la puede hacer');

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.agreedValue, null, 'el importe no es cosa suya');
  assert.equal(enBase.isCanje, false);
  assert.equal(String(enBase.doctor), String(doc._id), 'lo que sí puede hacer, se hizo');
});

test('sin mandar el valor, la cita se queda como estaba', async () => {
  const { clinicId, userId, doc, make } = await seedCase();
  const apt = await make({ agreedValue: 30, isCanje: false });

  await H.runController(
    appt.assignDoctor,
    H.mockReq(
      clinicId, userId,
      { steps: [{ kind: 'doctor', user: String(doc._id) }] },
      { role: 'cajero', params: { id: String(apt._id) } }
    )
  );

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.agreedValue, 30, 'añadir un doctor no puede borrar lo ya anotado');
});

// ── Corregir servicio y valor DESPUÉS de atender ─────────────────────────────
test('caja cambia el servicio y el valor con la cita ya completada', async () => {
  const { clinicId, userId, doc, botox, make } = await seedCase();
  const apt = await make({
    status: 'completada',
    doctor: doc._id,
    consultationEndedAt: new Date(),
    agreedValue: 20,
  });

  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(
      clinicId, userId,
      { serviceItem: String(botox._id), agreedValue: 150, isCanje: false },
      { role: 'cajero', params: { id: String(apt._id) } }
    )
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(apt._id);
  assert.equal(String(enBase.serviceItem), String(botox._id));
  assert.equal(enBase.serviceName, 'Botox', 'el snapshot tiene que seguir al servicio');
  assert.equal(enBase.agreedValue, 150);
  assert.equal(enBase.status, 'completada', 'corregir no reabre la cita');
  assert.equal(String(enBase.doctor), String(doc._id), 'y no toca a quien atendió');
});

test('corregir el servicio NO cambia quién atendió, aunque venga en el cuerpo', async () => {
  const { clinicId, userId, doc, botox, make } = await seedCase();
  const otro = await User.create({
    clinic: clinicId, name: 'DocB', email: `docb${Date.now()}@t.com`, password: 'secret123', role: 'doctor',
  });
  const apt = await make({ status: 'completada', doctor: doc._id, consultationEndedAt: new Date() });

  await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(
      clinicId, userId,
      // Se cuela un doctor y un estado: la puerta no los lee.
      { serviceItem: String(botox._id), doctor: String(otro._id), status: 'pendiente', turns: [] },
      { role: 'cajero', params: { id: String(apt._id) } }
    )
  );

  const enBase = await Appointment.findById(apt._id);
  assert.equal(String(enBase.doctor), String(doc._id), 'el doctor es intocable desde aquí');
  assert.equal(enBase.status, 'completada');
  assert.equal(enBase.serviceName, 'Botox', 'lo que sí se pedía, se hizo');
});

test('se puede quitar el servicio (dejarlo en blanco) y borrar el valor', async () => {
  const { clinicId, userId, make } = await seedCase();
  const apt = await make({ status: 'asistida', agreedValue: 60 });

  await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(
      clinicId, userId,
      { serviceItem: null, agreedValue: null, isCanje: false },
      { role: 'admin', params: { id: String(apt._id) } }
    )
  );

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.serviceItem, null);
  assert.equal(enBase.serviceName, '');
  assert.equal(enBase.agreedValue, null, 'vaciar el campo es "no anotado", no "cero"');
});

test('un valor negativo no se guarda', async () => {
  const { clinicId, userId, make } = await seedCase();
  const apt = await make({ status: 'asistida' });

  const r = await H.runController(
    appt.updateServiceAndValue,
    H.mockReq(
      clinicId, userId,
      { agreedValue: -10 },
      { role: 'cajero', params: { id: String(apt._id) } }
    )
  );
  assert.equal(r.statusCode, 400, 'no hay nada válido que cambiar');

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.agreedValue, null);
});

/**
 * AGENDAR CON VALOR DESDE EL ALTA DEL PACIENTE.
 *
 * Pacientes → «Agendar cita para este paciente» ahora pide el importe y el
 * canje, como la agenda. Eso hace que el valor llegue en el POST de creación,
 * y ahí el cuerpo se volcaba entero en la cita: cualquiera podía mandarlo.
 */
test('al crear la cita, caja puede dejar anotado el valor', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });

  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(
      clinicId, userId,
      { patient: patient._id, date: ymd(new Date(Date.now() + 86400000)), startTime: '09:00', agreedValue: 30 },
      { role: 'cajero' }
    )
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(r.payload._id);
  assert.equal(enBase.agreedValue, 30);
  assert.ok(enBase.valueSetBy, 'queda registrado quién lo puso');
});

test('al crear la cita, el canje deja el importe en 0 aunque venga uno', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });

  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(
      clinicId, userId,
      { patient: patient._id, date: ymd(new Date(Date.now() + 86400000)), startTime: '09:00', agreedValue: 30, isCanje: true },
      { role: 'admin' }
    )
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(r.payload._id);
  assert.equal(enBase.isCanje, true);
  assert.equal(enBase.agreedValue, 0);
});

test('quien atiende NO puede colar el valor al crear la cita', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'P' });

  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(
      clinicId, userId,
      { patient: patient._id, date: ymd(new Date(Date.now() + 86400000)), startTime: '09:00', agreedValue: 99, isCanje: true },
      { role: 'doctor' }
    )
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(r.payload._id);
  assert.equal(enBase.agreedValue, null, 'el importe se ignora: no es decisión suya');
  assert.equal(enBase.isCanje, false);
});

/**
 * EL VALOR ES DE MOSTRADOR TAMBIÉN AL EDITAR LA CITA.
 *
 * Las otras tres puertas por las que entra el importe pasan por
 * `aplicarValorDeCita`, que comprueba el rol y sella quién lo puso. El PUT de la
 * cita se volcaba entero en el update: call center —que puede editar citas— le
 * ponía precio a una consulta y encima sin dejar rastro de quién fue.
 */
test('call center puede editar la cita pero NO ponerle precio', async () => {
  const { clinicId, userId, make } = await seedCase();
  const apt = await make({ status: 'pendiente', agreedValue: 40 });

  const r = await H.runController(
    appt.updateAppointment,
    H.mockReq(
      clinicId, userId,
      { reason: 'Reagendada por el paciente', agreedValue: 999, isCanje: true },
      { role: 'call_center', params: { id: String(apt._id) } }
    )
  );
  assert.equal(r.statusCode ?? 200, 200, JSON.stringify(r.payload));

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.reason, 'Reagendada por el paciente', 'lo que sí puede tocar, se guarda');
  assert.equal(enBase.agreedValue, 40, 'el importe se queda como estaba');
  assert.equal(enBase.isCanje, false, 'y el canje tampoco es suyo');
});

test('caja sí lo cambia por esa misma puerta, y queda quién y cuándo', async () => {
  const { clinicId, userId, make } = await seedCase();
  const apt = await make({ status: 'pendiente', agreedValue: 40 });

  await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { agreedValue: 75 }, { role: 'cajero', params: { id: String(apt._id) } })
  );

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.agreedValue, 75);
  assert.ok(enBase.valueSetAt, 'queda sellado cuándo');
  assert.equal(String(enBase.valueSetBy), String(userId), 'y quién');
});

test('una cita completada NO se reescribe por el PUT: para eso está service-value', async () => {
  const { clinicId, userId, make } = await seedCase();
  const apt = await make({ status: 'completada', consultationEndedAt: new Date() });

  const r = await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { date: '2030-01-01', status: 'pendiente' },
      { role: 'cajero', params: { id: String(apt._id) } })
  );
  assert.equal(r.statusCode, 403, JSON.stringify(r.payload));
  assert.equal(r.payload.code, 'COMPLETED_ONLY_SERVICE_VALUE');

  const enBase = await Appointment.findById(apt._id);
  assert.equal(enBase.status, 'completada', 'la atención que ya ocurrió no se mueve');
});

test('una cita completada tampoco se cancela: la atención ocurrió', async () => {
  const { clinicId, userId, make } = await seedCase();
  const apt = await make({ status: 'completada', consultationEndedAt: new Date() });

  const r = await H.runController(
    appt.deleteAppointment,
    H.mockReq(clinicId, userId, {}, { role: 'cajero', params: { id: String(apt._id) }, query: {} })
  );
  assert.equal(r.statusCode, 403, JSON.stringify(r.payload));
  assert.equal((await Appointment.findById(apt._id)).status, 'completada');
});
