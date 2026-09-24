/**
 * «PACIENTE NUEVO» NO ES «PACIENTE RECIÉN TECLEADO».
 *
 * La marca `isFirstVisit` se congela en la cita y de ella cuelgan cosas que se
 * pagan: las comisiones de captación (`patientScope: 'new'`), los reportes de
 * pacientes nuevos y el badge de la agenda.
 *
 * Hasta sep-2026 la pregunta era «¿tiene citas anteriores?», y eso dejaba fuera
 * justo a los que llevaban años viniendo: los que se atendían EN PAPEL. Sus
 * fichas físicas se escanearon y su historia se subió, pero como nunca habían
 * pasado por la agenda, la primera cita que se les agendaba los estrenaba como
 * pacientes nuevos —y pagaba una captación que no existió—.
 *
 * Lo que estos tests vigilan (ver utils/firstVisit.js):
 *  1. El paciente de verdad nuevo SIGUE marcándose como nuevo.
 *  2. El que ya tiene consultas en su historia, no.
 *  3. El que vino del archivo físico (`scanImport`), tampoco, aunque su ficha
 *     todavía no se haya convertido en seguimiento.
 *  4. El que ya tiene una venta a su nombre (los que llegaron de Contífico),
 *     tampoco.
 *  5. Una cita en OTRA sucursal cuenta: nuevo se es para la clínica, no para
 *     la sede.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const Sale = require('../models/Sale');
const appt = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed(datosPaciente = {}) {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405',
    ...datosPaciente,
  });
  return { clinicId, userId, patient };
}

/**
 * Agenda una cita como mostrador y devuelve la cita guardada.
 *
 * La HORA es un parámetro porque al mismo paciente no se le puede agendar dos
 * veces en el mismo hueco (ver `utils/citaRepetida.js`), y aquí se agenda dos
 * veces seguidas para comprobar otra cosa: cuál de las dos es su primera visita.
 */
async function agendar(clinicId, userId, patientId, startTime = '10:00') {
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  // El servicio es obligatorio desde sep-2026: los tests lo llevan por defecto.
  const svc = await require('../models/AppointmentServiceItem').create({
    clinic: clinicId, name: 'Control', slug: `control-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
  });
  const r = await H.runController(
    appt.createAppointment,
    H.mockReq(clinicId, userId, {
      patient: String(patientId),
      date: manana.toISOString().slice(0, 10),
      startTime,
      reason: 'Control',
      serviceItem: svc._id,
    }, { role: 'cajero' }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));
  return Appointment.findById(r.payload._id || r.payload.appointment?._id).lean();
}

test('el paciente que llega por primera vez SÍ es nuevo', async () => {
  const { clinicId, userId, patient } = await seed();
  const cita = await agendar(clinicId, userId, patient._id);
  assert.equal(cita.isFirstVisit, true, 'sin ningún rastro previo, es nuevo');
});

test('el que ya tiene consultas en su historia no es nuevo', async () => {
  const { clinicId, userId, patient } = await seed();
  // La historia subida por Excel o convertida desde una ficha escaneada.
  await ClinicalRecord.create({
    clinic: clinicId, patient: patient._id, createdBy: userId,
    followUps: [{ fecha: new Date('2024-05-10'), motivoConsulta: 'Control', createdBy: userId }],
  });

  const cita = await agendar(clinicId, userId, patient._id);
  assert.equal(cita.isFirstVisit, false, 'lleva años viniendo, solo que en papel');
});

test('el que vino del archivo físico no es nuevo aunque no tenga seguimientos', async () => {
  const { clinicId, userId, patient } = await seed({
    scanImport: { importadoAt: new Date('2026-09-03') },
  });

  const cita = await agendar(clinicId, userId, patient._id);
  assert.equal(cita.isFirstVisit, false, 'su ficha estaba en el archivador');
});

test('el que ya tiene una venta a su nombre no es nuevo', async () => {
  const { clinicId, userId, patient } = await seed();
  const producto = await H.makeProduct(clinicId, { name: 'Consulta', salePrice: 20 });
  await Sale.create({
    clinic: clinicId, patient: patient._id, createdBy: userId,
    items: [{ product: producto._id, name: 'Consulta', quantity: 1, unitPrice: 20, subtotal: 20 }],
    subtotal: 20, taxAmount: 0, total: 20,
  });

  const cita = await agendar(clinicId, userId, patient._id);
  assert.equal(cita.isFirstVisit, false, 'ya compró aquí antes');
});

test('una cita en otra sucursal también cuenta: nuevo se es para la clínica', async () => {
  const { clinicId, userId, patient } = await seed();
  const otraSede = new H.mongoose.Types.ObjectId();
  await Appointment.create({
    clinic: otraSede, patient: patient._id, date: H.docDate(), startTime: '09:00',
    status: 'completada',
  });

  const cita = await agendar(clinicId, userId, patient._id);
  assert.equal(cita.isFirstVisit, false, 'ya lo atendieron en la otra sede');
});

test('la segunda cita del mismo paciente nunca es la primera', async () => {
  const { clinicId, userId, patient } = await seed();
  const primera = await agendar(clinicId, userId, patient._id);
  const segunda = await agendar(clinicId, userId, patient._id, '11:00');

  assert.equal(primera.isFirstVisit, true);
  assert.equal(segunda.isFirstVisit, false);
});

test('solo administración y marketing pueden quitar una marca errónea de paciente nuevo', async () => {
  const { clinicId, userId, patient } = await seed();
  const crearCitaNueva = (hora) => Appointment.create({
    clinic: clinicId,
    patient: patient._id,
    date: H.docDate(1),
    startTime: hora,
    status: 'completada',
    createdBy: userId,
    isFirstVisit: true,
  });

  const restringida = await crearCitaNueva('09:00');
  const sinPermiso = await H.runController(
    appt.clearFirstVisit,
    H.mockReq(clinicId, userId, {}, { role: 'cajero', params: { id: String(restringida._id) } }),
  );
  assert.equal(sinPermiso.statusCode, 403);
  assert.equal((await Appointment.findById(restringida._id)).isFirstVisit, true);

  const admin = await crearCitaNueva('10:00');
  const comoAdmin = await H.runController(
    appt.clearFirstVisit,
    H.mockReq(clinicId, userId, {}, { role: 'admin', params: { id: String(admin._id) } }),
  );
  assert.equal(comoAdmin.statusCode, 200, JSON.stringify(comoAdmin.payload));
  assert.equal(comoAdmin.payload.isFirstVisit, false);

  const marketing = await crearCitaNueva('11:00');
  const comoMarketing = await H.runController(
    appt.clearFirstVisit,
    H.mockReq(clinicId, userId, {}, { role: 'marketing', params: { id: String(marketing._id) } }),
  );
  assert.equal(comoMarketing.statusCode, 200, JSON.stringify(comoMarketing.payload));
  assert.equal(comoMarketing.payload.isFirstVisit, false);

  const guardada = await Appointment.findById(marketing._id);
  assert.equal(String(guardada.firstVisitCorrectedBy), String(userId));
  assert.ok(guardada.firstVisitCorrectedAt instanceof Date, 'queda auditada la corrección');
});
