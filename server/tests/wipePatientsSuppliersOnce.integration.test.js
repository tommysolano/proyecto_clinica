/**
 * ARRANQUE DESDE CERO DE UNA SOLA VEZ (scripts/wipePatientsSuppliersOnce.js).
 *
 * Este script borra datos de PRODUCCIÓN de forma irreversible, así que lo que
 * importa demostrar no es que borra —eso es lo fácil— sino DÓNDE SE DETIENE:
 *   · Marketing / CRM y el escáner tienen que quedar exactamente igual.
 *   · Los chats tienen que quedar DESVINCULADOS, no rotos: si el enlace al
 *     paciente borrado sobrevive, la bandeja miente y las bajas de marketing
 *     dejan de registrarse (ver la cabecera del script).
 *   · Y debe correr una sola vez: un push posterior no puede llevarse los
 *     pacientes que se cargaron después.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const { wipeAll, runOnce } = require('../scripts/wipePatientsSuppliersOnce');

// Lo que SÍ se borra.
const Patient = require('../models/Patient');
const ClinicalRecord = require('../models/ClinicalRecord');
const Appointment = require('../models/Appointment');
const Treatment = require('../models/Treatment');
const Supplier = require('../models/Supplier');
const ChartOfAccount = require('../models/ChartOfAccount');
const Product = require('../models/Product');
const OneTimeTask = require('../models/OneTimeTask');

// Lo que NO se puede tocar.
const Conversation = require('../models/Conversation');
const Message = require('../models/Message');
const Contact = require('../models/Contact');
const MessageTemplate = require('../models/MessageTemplate');
const Workflow = require('../models/Workflow');
const ScannedDocument = require('../models/ScannedDocument');
const User = require('../models/User');
const Employee = require('../models/Employee');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const silencio = () => {};

/** Un paciente con su historia: ficha, cita y plan de tratamiento. */
async function sembrarPaciente(clinicId, userId) {
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0102030405', phone: '0999111222',
  });
  await ClinicalRecord.create({ clinic: clinicId, patient: patient._id, followUps: [] });
  await Appointment.create({
    clinic: clinicId, patient: patient._id, date: new Date(), startTime: '09:00', endTime: '09:30',
    createdBy: userId,
  });
  await Treatment.create({
    clinic: clinicId, patient: patient._id, name: 'Plan', items: [], createdBy: userId,
  });
  return patient;
}

/** Marketing / CRM y el escáner: lo que tiene que sobrevivir intacto. */
async function sembrarIntocable(clinicId, userId, patientId) {
  const conv = await Conversation.create({
    clinic: clinicId, phone: '593999111222', channel: 'whatsapp', contactName: 'Ana', patient: patientId,
  });
  await Message.create({ clinic: clinicId, conversation: conv._id, direction: 'in', body: 'Hola' });
  await Contact.create({ clinic: clinicId, phone: '593999111222', firstName: 'Ana', patient: patientId });
  await MessageTemplate.create({ clinic: clinicId, name: 'saludo', body: 'Hola {{nombre}}' });
  await Workflow.create({ clinic: clinicId, name: 'Bienvenida', trigger: { type: 'appointment_created' }, steps: [] });
  await ScannedDocument.create({
    clinic: clinicId, name: 'Contrato', nameKey: 'contrato', filename: 'x.pdf', size: 10, pages: 1,
    createdBy: userId,
  });
  // El personal de la clínica: no son datos de clientes y tiene que sobrevivir.
  await User.create({
    name: 'Recepción', email: 'recepcion@example.com', password: 'secreto1',
    clinics: [{ clinic: clinicId, role: 'cajero' }],
  });
  await Employee.create({
    clinic: clinicId, code: 'EMP-1', firstName: 'Luis', lastName: 'Mora',
    identificacion: '0911223344', baseSalary: 460, hireDate: new Date(),
  });
  return conv;
}

// ─────────────────────────────────────────────────────────────────────────────

test('W1) dry-run: informa lo que borraría y no borra nada', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await sembrarPaciente(clinicId, userId);
  await H.makeSupplier(clinicId);

  const res = await wipeAll({ commit: false, log: silencio });

  assert.equal(res.dryRun, true);
  assert.ok(res.totalDocs > 0, 'cuenta documentos');
  assert.ok(await Patient.findById(patient._id), 'el paciente sigue ahí');
  assert.equal(await Supplier.countDocuments({}), 1, 'el proveedor sigue ahí');
});

test('W2) borra el paciente y toda su historia clínica', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await sembrarPaciente(clinicId, userId);

  await wipeAll({ commit: true, log: silencio });

  assert.equal(await Patient.countDocuments({}), 0, 'pacientes');
  assert.equal(await ClinicalRecord.countDocuments({}), 0, 'fichas clínicas');
  assert.equal(await Appointment.countDocuments({}), 0, 'citas');
  assert.equal(await Treatment.countDocuments({}), 0, 'tratamientos');
});

test('W3) borra los terceros y los catálogos contables', async () => {
  const { clinicId } = await H.seedClinic();
  await H.makeSupplier(clinicId);
  await H.makeProduct(clinicId, { category: 'insumo', salePrice: 10 });

  assert.ok(await ChartOfAccount.countDocuments({}) > 0, 'la clínica nace con plan de cuentas');

  await wipeAll({ commit: true, log: silencio });

  assert.equal(await Supplier.countDocuments({}), 0, 'personas / terceros');
  assert.equal(await Product.countDocuments({}), 0, 'productos');
  assert.equal(await ChartOfAccount.countDocuments({}), 0, 'plan de cuentas');
});

test('W4) Marketing / CRM y el ESCÁNER quedan intactos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await sembrarPaciente(clinicId, userId);
  await sembrarIntocable(clinicId, userId, patient._id);

  await wipeAll({ commit: true, log: silencio });

  assert.equal(await Conversation.countDocuments({}), 1, 'el chat sigue');
  assert.equal(await Message.countDocuments({}), 1, 'sus mensajes siguen');
  assert.equal(await Contact.countDocuments({}), 1, 'el contacto sigue');
  assert.equal(await MessageTemplate.countDocuments({}), 1, 'las plantillas siguen');
  assert.equal(await Workflow.countDocuments({}), 1, 'las automatizaciones siguen');
  // El requisito explícito del usuario: el escáner no se toca.
  assert.equal(await ScannedDocument.countDocuments({}), 1, 'el documento escaneado sigue');
  // Y el personal tampoco: no son datos de clientes.
  assert.equal(await User.countDocuments({}), 1, 'los usuarios siguen');
  assert.equal(await Employee.countDocuments({}), 1, 'los empleados siguen');
});

test('W5) el chat queda DESVINCULADO, no roto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const patient = await sembrarPaciente(clinicId, userId);
  const conv = await sembrarIntocable(clinicId, userId, patient._id);

  await wipeAll({ commit: true, log: silencio });

  const guardada = await Conversation.findById(conv._id);
  assert.ok(guardada, 'la conversación sobrevive');
  // Si el id sobreviviera, la bandeja diría "Paciente vinculado" sobre alguien que
  // ya no existe y la baja de marketing dejaría de registrarse.
  assert.equal(guardada.patient, null, 'el enlace al paciente borrado se limpia');
  assert.equal(guardada.contactName, 'Ana', 'lo demás del chat no se toca');

  const contacto = await Contact.findOne({});
  assert.equal(contacto.patient, null, 'el contacto también se desvincula');
  assert.ok(contacto.firstName, 'pero el contacto sigue siendo el mismo');
});

test('W6) la tarea se ejecuta UNA sola vez: el push siguiente no borra los pacientes nuevos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  await sembrarPaciente(clinicId, userId);
  const KEY = 'test-borrar-pacientes';

  const primera = await runOnce({ key: KEY, log: silencio });
  assert.equal(primera.skipped, false);
  assert.equal(await Patient.countDocuments({}), 0);

  // La clínica vuelve a operar y carga un paciente nuevo.
  await sembrarPaciente(clinicId, userId);

  const segunda = await runOnce({ key: KEY, log: silencio });
  assert.equal(segunda.skipped, true, 'el segundo despliegue no hace nada');
  assert.equal(segunda.status, 'DONE');
  assert.equal(await Patient.countDocuments({}), 1, 'el paciente nuevo SIGUE AHÍ');

  const marca = await OneTimeTask.findById(KEY).lean();
  assert.equal(marca.status, 'DONE');
  assert.ok(marca.result, 'queda constancia de lo que se borró');
});
