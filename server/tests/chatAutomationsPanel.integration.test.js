/**
 * Panel del contacto: qué automatizaciones se han activado en ESTE chat.
 *
 * Lo delicado no es listar: es ENCONTRAR las inscripciones. Solo las lanzadas
 * desde el propio chat guardan `conversation`; las de los disparadores de dominio
 * (cita agendada, cumpleaños, importación) inscriben al PACIENTE y únicamente
 * dejan el teléfono —tal cual está en la ficha, p.ej. '0999111222'— en el
 * contexto, mientras que el chat lo tiene en formato internacional
 * ('593999111222'). Si el emparejamiento falla, el agente ve el panel vacío
 * justo en el caso más común.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const chat = require('../controllers/chatController');
const Conversation = require('../models/Conversation');
const Patient = require('../models/Patient');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const listar = async (clinicId, conv) => {
  const r = await H.runController(
    chat.listChatAutomations,
    H.mockReq(clinicId, null, {}, { params: { id: String(conv._id) } })
  );
  assert.equal(r.statusCode, 200, JSON.stringify(r.payload));
  return r.payload;
};

const makeWorkflow = (clinicId, name, extra = {}) =>
  Workflow.create({ clinic: clinicId, name, active: true, ...extra });

test('la lanzada desde el chat aparece con su estado y su registro', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
  const wf = await makeWorkflow(clinicId, 'Bienvenida', { folder: 'Captación' });
  await WorkflowEnrollment.create({
    clinic: clinicId,
    workflow: wf._id,
    conversation: conv._id,
    status: 'waiting',
    nextRunAt: new Date(Date.now() + 3600000),
    context: { phone: '593999111222', conversationId: String(conv._id), eventType: 'manual' },
    log: [
      { type: 'send_message', ok: true, info: 'Mensaje enviado' },
      { type: 'send_template', ok: false, info: 'Fuera de la ventana de 24h' },
    ],
    lastError: 'Fuera de la ventana de 24h',
  });

  const rows = await listar(clinicId, conv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Bienvenida');
  assert.equal(rows[0].status, 'waiting');
  assert.equal(rows[0].eventType, 'manual');
  assert.equal(rows[0].okCount, 1);
  assert.equal(rows[0].failCount, 1);
  assert.equal(rows[0].lastError, 'Fuera de la ventana de 24h');
  assert.equal(rows[0].log.length, 2);
});

test('la de un disparador de cita (sin conversación, teléfono local) también sale', async () => {
  const { clinicId } = await H.seedClinic();
  const patient = await Patient.create({
    clinic: clinicId, firstName: 'Ana', lastName: 'Pérez', cedula: '0912345678', phone: '0999111222',
  });
  const conv = await Conversation.create({
    clinic: clinicId, channel: 'whatsapp', phone: '593999111222', patient: patient._id,
  });
  const wf = await makeWorkflow(clinicId, 'Recordatorio de cita');
  // Así la crea el motor: sin `conversation` y con el teléfono de la ficha.
  await WorkflowEnrollment.create({
    clinic: clinicId,
    workflow: wf._id,
    patient: patient._id,
    status: 'active',
    context: { phone: '0999111222', eventType: 'appointment_created' },
  });

  const rows = await listar(clinicId, conv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Recordatorio de cita');
  assert.equal(rows[0].eventType, 'appointment_created');
});

test('sin paciente enlazado, el teléfono en otro formato basta para encontrarla', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
  const wf = await makeWorkflow(clinicId, 'Goteo de importación');
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'waiting', context: { phone: '+593 99 911 1222' },
  });

  const rows = await listar(clinicId, conv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Goteo de importación');
});

test('las de OTRO contacto no se mezclan en el panel', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
  const otra = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593988000111' });
  const wf = await makeWorkflow(clinicId, 'Promo octubre');
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, conversation: otra._id, status: 'done', context: { phone: '593988000111' },
  });

  assert.deepEqual(await listar(clinicId, conv), []);
  const rows = await listar(clinicId, otra);
  assert.equal(rows.length, 1);
});

test('el disparador del flujo sale aunque el contexto no guarde el evento', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
  // Workflow de grafo: el nodo disparador manda sobre los triggers de cabecera.
  const wf = await makeWorkflow(clinicId, 'Respuesta a palabra clave', {
    nodes: [{ id: 'trg1', type: 'trigger', data: { triggers: [{ type: 'keyword', keywords: ['precio'] }] } }],
    triggers: [{ type: 'inbound_message' }],
  });
  await WorkflowEnrollment.create({
    clinic: clinicId,
    workflow: wf._id,
    conversation: conv._id,
    startNodeId: 'trg1',
    status: 'done',
    context: { phone: '593999111222', conversationId: String(conv._id) },
  });

  const rows = await listar(clinicId, conv);
  assert.deepEqual(rows[0].triggerTypes, ['keyword']);
});

test('un workflow borrado no rompe el panel: la inscripción sigue visible', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
  const wf = await makeWorkflow(clinicId, 'Flujo viejo');
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, conversation: conv._id, status: 'done', context: { phone: '593999111222' },
  });
  await Workflow.deleteOne({ _id: wf._id });

  const rows = await listar(clinicId, conv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].deleted, true);
});

test('chat de otra clínica: 404 (no se filtra información entre clínicas)', async () => {
  const { clinicId } = await H.seedClinic();
  const otraClinica = await H.seedClinic();
  const conv = await Conversation.create({ clinic: clinicId, channel: 'whatsapp', phone: '593999111222' });
  const r = await H.runController(
    chat.listChatAutomations,
    H.mockReq(otraClinica.clinicId, null, {}, { params: { id: String(conv._id) } })
  );
  assert.equal(r.statusCode, 404);
});
