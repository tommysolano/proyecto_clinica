/**
 * LOS AVISOS DE ENFERMERÍA DICEN A QUIÉN Y LLEVAN A DONDE SE ATIENDE.
 *
 * En la campana del enfermero se apilaban avisos indistinguibles —«El doctor
 * terminó su parte de la consulta», «Mostrador acaba de recetar un suero»— sin
 * decir de qué paciente hablaban, y al tocarlos soltaban en la agenda, con
 * decenas de citas del día, a buscar otra vez la que el aviso ya identificaba.
 *
 * Lo que estos tests fijan:
 *  1. El nombre del paciente encabeza SIEMPRE el cuerpo del aviso.
 *  2. El enlace apunta a los seguimientos DE ESE paciente, con su cita.
 *  3. Vale para los tres caminos por los que llega trabajo a enfermería:
 *     recepción asigna, el doctor termina su turno, y mostrador receta un suero.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Appointment = require('../models/Appointment');
const Notification = require('../models/Notification');
const Patient = require('../models/Patient');
const User = require('../models/User');
const ClinicalRecord = require('../models/ClinicalRecord');
const records = require('../controllers/clinicalRecordController');
const appt = require('../controllers/appointmentController');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seed() {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Jorge', lastName: 'Avilés Villón', cedula: '0102030405',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, createdBy: userId });

  const crear = (name, role) =>
    User.create({
      name, email: `${name.toLowerCase()}@t.com`, password: 'secreto123',
      clinics: [{ clinic: clinicId, role }],
    });

  return {
    clinicId,
    patient,
    cajero: await crear('Caja', 'cajero'),
    doctor: await crear('DocA', 'doctor'),
    enfermera: await crear('Enfer', 'enfermero'),
  };
}

/** El aviso de enfermería que llegó a la campana (el último). */
const avisoEnfermeria = () =>
  Notification.findOne({ type: 'appointment_nursing' }).sort({ createdAt: -1 }).lean();

/** Las dos cosas que un aviso tiene que traer, en un solo sitio. */
function assertAvisoUtil(aviso, { cita, patientId }) {
  assert.ok(aviso, 'el aviso llegó a la campana');
  assert.match(aviso.body, /^Jorge Avilés Villón/i, `el paciente encabeza el aviso: "${aviso.body}"`);
  assert.equal(
    aviso.meta?.url,
    `/patients/${patientId}?tab=seguimientos&appointment=${cita}`,
    'lleva a los seguimientos del paciente, no a la agenda'
  );
}

test('recepción manda la cita a enfermería: el aviso trae el paciente y su ficha', async () => {
  const { clinicId, patient, cajero, enfermera } = await seed();

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(),
    startTime: '14:28', status: 'pendiente', serviceName: 'Sueroterapia',
    createdBy: cajero._id,
  });

  const r = await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, cajero._id, { steps: [{ kind: 'enfermeria', serviceName: 'Sueroterapia' }] },
      { role: 'cajero', params: { id: String(cita._id) } }),
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));

  const aviso = await avisoEnfermeria();
  assertAvisoUtil(aviso, { cita: cita._id, patientId: patient._id });
  // El servicio y la hora siguen ahí: es lo que deja saber a qué se va.
  assert.match(aviso.body, /Sueroterapia/);
  assert.match(aviso.body, /14:28/);
  assert.equal(String(aviso.user), String(enfermera._id), 'es de quien puede atenderla');
});

test('el doctor termina y pasa a enfermería: el aviso dice a quién hay que atender', async () => {
  const { clinicId, patient, cajero, doctor, enfermera } = await seed();

  const cita = await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(),
    startTime: '09:00', status: 'pendiente', createdBy: cajero._id,
  });
  await H.runController(
    appt.assignDoctor,
    H.mockReq(clinicId, cajero._id,
      { steps: [{ kind: 'doctor', user: String(doctor._id) }, { kind: 'enfermeria', serviceName: 'Detox' }] },
      { role: 'cajero', params: { id: String(cita._id) } }),
  );
  await Notification.deleteMany({}); // solo interesa el aviso del relevo

  const r = await H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, doctor._id,
      { motivoConsulta: 'Control', appointmentId: String(cita._id) },
      { role: 'doctor', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const aviso = await avisoEnfermeria();
  assertAvisoUtil(aviso, { cita: cita._id, patientId: patient._id });
  assert.match(aviso.body, /Detox/, 'el servicio del turno, no el genérico de la cita');
  assert.equal(String(aviso.user), String(enfermera._id));
});

test('mostrador receta un suero: el aviso trae paciente y suero, y abre su ficha', async () => {
  const { clinicId, patient, cajero } = await seed();

  const r = await H.runController(
    records.addFollowUp,
    H.mockReq(clinicId, cajero._id,
      {
        motivoConsulta: 'Suero',
        recetaItems: [{
          name: 'Suero vitamina C', quantity: 1, isSerum: true,
          serumBase: { name: 'Cloruro', volumeMl: 250 },
        }],
      },
      { role: 'cajero', params: { patientId: String(patient._id) } }),
  );
  assert.equal(r.statusCode, 201, JSON.stringify(r.payload));

  const cita = await Appointment.findOne({ clinic: clinicId }).lean();
  const aviso = await avisoEnfermeria();
  assertAvisoUtil(aviso, { cita: cita._id, patientId: patient._id });
  assert.match(aviso.body, /Suero vitamina C/, 'dice QUÉ hay que poner');
});
