/**
 * CATÁLOGO DE SERVICIOS DE AGENDA.
 *
 * El servicio de una cita era un producto del INVENTARIO y era obligatorio para
 * poder agendar. Al separar la parte operativa de la contable, la agenda pasa a
 * tener su propia lista, que cualquiera que agende puede ampliar sobre la marcha.
 *
 * Lo que vigilan estos tests:
 *  1. Que se pueda agendar SIN servicio (antes devolvía 400 y bloqueaba).
 *  2. Que el catálogo no se ensucie: «Botox», «botox» y «BOTOX» tienen que ser
 *     UNO. Es el destrozo silencioso que ya sufrieron las métricas del CRM.
 *  3. Que el nombre quede en la cita como SNAPSHOT: la lista, los reportes y el
 *     recordatorio de WhatsApp lo leen sin populate.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const AppointmentServiceItem = require('../models/AppointmentServiceItem');
const Patient = require('../models/Patient');
const ctrl = require('../controllers/appointmentServiceItemController');
const appt = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const crear = (clinicId, userId, body, role = 'cajero') =>
  H.runController(ctrl.create, H.mockReq(clinicId, userId, body, { role }));

async function paciente(clinicId) {
  return Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405' });
}

// ───────────────────── el catálogo ─────────────────────

test('crear un servicio al vuelo y volver a pedirlo devuelve el MISMO', async () => {
  const { clinicId, userId } = await H.seedClinic();

  const a = await crear(clinicId, userId, { name: 'Ecocardiograma' });
  assert.equal(a.statusCode, 201);

  // Otra recepcionista, con otras mayúsculas y una tilde de más.
  const b = await crear(clinicId, userId, { name: '  ECOCARDIÓGRAMA  ' });
  assert.equal(b.statusCode, 200, 'no es un duplicado: es el que ya estaba');
  assert.equal(String(b.payload._id), String(a.payload._id));

  const total = await AppointmentServiceItem.countDocuments();
  assert.equal(total, 1, 'un solo servicio en el catálogo');
});

test('el catálogo es de toda la organización, no de una sucursal', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await crear(clinicId, userId, { name: 'Biorresonancia' });

  // Otra sucursal pide el listado: tiene que ver el servicio igual, o cada sede
  // acabaría creando el suyo.
  const otraClinica = new H.mongoose.Types.ObjectId();
  const r = await H.runController(ctrl.list, H.mockReq(otraClinica, userId, {}, { role: 'cajero' }));
  assert.equal(r.payload.length, 1);
  assert.equal(r.payload[0].name, 'Biorresonancia');
});

test('un servicio dado de baja no sale al agendar, pero vuelve si alguien lo escribe', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const creado = await crear(clinicId, userId, { name: 'Ozonoterapia' });

  await H.runController(
    ctrl.remove,
    H.mockReq(clinicId, userId, {}, { role: 'admin', params: { id: String(creado.payload._id) } }),
  );
  const activos = await H.runController(ctrl.list, H.mockReq(clinicId, userId, {}, { role: 'cajero' }));
  assert.equal(activos.payload.length, 0, 'no se ofrece');

  // Nadie lo borró de verdad: las citas viejas lo referencian.
  const otraVez = await crear(clinicId, userId, { name: 'Ozonoterapia' });
  assert.equal(String(otraVez.payload._id), String(creado.payload._id));
  assert.equal(otraVez.payload.active, true, 'volver a usarlo lo reactiva');
});

test('un nombre en blanco no crea nada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const r = await crear(clinicId, userId, { name: '   ' });
  assert.equal(r.statusCode, 400);
});

// ───────────────────── la cita ─────────────────────

test('se agenda SIN servicio (antes daba 400 y bloqueaba)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await paciente(clinicId);

  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, userId, {
      patient: String(p._id),
      date: H.docDate(),
      startTime: '23:30',
    }, { role: 'cajero' }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  assert.equal(r.payload.serviceItem, null);
});

test('agendar con servicio guarda el nombre como snapshot y suma un uso', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await paciente(clinicId);
  const svc = await crear(clinicId, userId, { name: 'Eco 360' });

  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, userId, {
      patient: String(p._id),
      date: H.docDate(),
      startTime: '23:30',
      serviceItem: String(svc.payload._id),
    }, { role: 'cajero' }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(r.payload._id).lean();
  assert.equal(String(guardada.serviceItem), String(svc.payload._id));
  // El snapshot es lo que leen la lista, los reportes y el recordatorio: sin él,
  // renombrar el servicio cambiaría el historial.
  assert.equal(guardada.serviceName, 'Eco 360');

  const item = await AppointmentServiceItem.findById(svc.payload._id).lean();
  assert.equal(item.usageCount, 1, 'lo más usado sube en el buscador');
});

test('editar una cita sin mandar el servicio NO se lo borra', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const p = await paciente(clinicId);
  const svc = await crear(clinicId, userId, { name: 'Consulta Cardio' });
  const creada = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, userId, {
      patient: String(p._id), date: H.docDate(), startTime: '23:30', serviceItem: String(svc.payload._id),
    }, { role: 'cajero' }),
  );

  // Se edita solo el motivo, como hace el formulario al cambiar cualquier campo.
  const r = await H.runController(
    appt.updateAppointment,
    H.mockReq(clinicId, userId, { reason: 'Cambio de motivo' },
      { role: 'cajero', params: { id: String(creada.payload._id) } }),
  );
  assert.equal(r.statusCode < 400, true, JSON.stringify(r.payload));

  const guardada = await Appointment.findById(creada.payload._id).lean();
  assert.equal(guardada.serviceName, 'Consulta Cardio', 'el servicio sigue ahí');
});
