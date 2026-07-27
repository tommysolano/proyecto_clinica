/**
 * Envío masivo: UN mensaje por contacto, y el mensaje de ESTA campaña.
 *
 * Los dos fallos que cubre este archivo costaban dinero de verdad — son envíos de
 * plantilla, y Meta cobra cada uno:
 *
 *   1. Un flujo con DOS nodos disparadores "Contactos importados" inscribía al
 *      contacto una vez por cada uno → el mismo mensaje salía dos veces.
 *   2. Una prueba de envío deja inscripciones "en espera" que siguen soltando SU
 *      mensaje durante horas (el goteo tarda). Al lanzar el envío bueno, al
 *      contacto le llegaba el texto del Excel anterior mezclado con el nuevo.
 *
 * Y de paso: por qué número sale cada mensaje (el del contacto, o el fijado).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Contact = require('../models/Contact');
const ContactImport = require('../models/ContactImport');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const WhatsappAccount = require('../models/WhatsappAccount');
const { enrollInWorkflows } = require('../utils/contactImportRunner');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const MAPPING = [
  { column: 'Nombre', field: 'displayName', skipEmpty: true },
  { column: 'Celular', field: 'phone', skipEmpty: true },
];

/** Flujo lineal normal, con un único disparador de importación. */
function unTrigger(clinicId) {
  return Workflow.create({
    clinic: clinicId,
    name: 'Promo julio',
    active: true,
    trigger: { type: 'contact_import' },
    steps: [{ type: 'send_message', body: 'Promo de julio' }],
  });
}

/** Flujo de grafo con DOS nodos disparadores "Contactos importados". */
function dosTriggers(clinicId) {
  return Workflow.create({
    clinic: clinicId,
    name: 'Promo con dos disparadores',
    active: true,
    triggers: [{ type: 'contact_import' }],
    steps: [],
    nodes: [
      { id: 't1', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'contact_import' }] } },
      { id: 'n1', type: 'send_message', position: { x: 0, y: 130 }, data: { body: 'Promo' } },
      { id: 't2', type: 'trigger', position: { x: 300, y: 0 }, data: { triggers: [{ type: 'contact_import' }] } },
      { id: 'n2', type: 'send_message', position: { x: 300, y: 130 }, data: { body: 'Promo' } },
    ],
    edges: [
      { id: 'e1', source: 't1', target: 'n1', sourceHandle: 'default' },
      { id: 'e2', source: 't2', target: 'n2', sourceHandle: 'default' },
    ],
  });
}

function makeBatch(clinicId, userId, wf, extra = {}) {
  return ContactImport.create({
    clinic: clinicId,
    fileName: 'lista.csv',
    status: 'done',
    mapping: MAPPING,
    workflows: [wf._id],
    createdBy: userId,
    ...extra,
  });
}

// ─────────── 1. un solo mensaje por contacto ───────────

test('flujo con DOS disparadores de importación: el contacto se inscribe UNA vez, no dos', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await dosTriggers(clinicId);
  await Contact.create({ clinic: clinicId, phone: '593999111222', firstName: 'Ligia' });

  const batch = await makeBatch(clinicId, userId, wf);
  const n = await enrollInWorkflows(batch, ['593999111222']);

  assert.equal(n, 1, 'dos disparadores no pueden significar dos mensajes: Meta cobra cada plantilla');
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 1);
  assert.match(batch.enrollWarning, /disparadores/i, 'y queda dicho por qué, para que lo arreglen en el editor');
});

test('una inscripción viva bloquea otra del mismo flujo aunque entre por OTRO disparador', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await dosTriggers(clinicId);
  const contact = await Contact.create({ clinic: clinicId, phone: '593999111222', firstName: 'Ligia' });

  // Ya estaba en cola, habiendo entrado por el segundo disparador.
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'waiting',
    startNodeId: 't2', currentNodeId: 'n2', nextRunAt: new Date(Date.now() + 3600e3),
    context: { phone: '593999111222', contactId: String(contact._id), eventType: 'contact_import' },
  });

  const batch = await makeBatch(clinicId, userId, wf, { cancelPending: false });
  assert.equal(await enrollInWorkflows(batch, ['593999111222']), 0, 'no se le vuelve a encolar');
  assert.equal(await WorkflowEnrollment.countDocuments({ workflow: wf._id }), 1);
});

// ─────────── 2. nunca el mensaje del Excel anterior ───────────

test('cancelPending: se cancela lo que seguía en cola del envío anterior; lo ya enviado no se toca', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const enCola = await Contact.create({ clinic: clinicId, phone: '593977000001', firstName: 'Previo' });
  const entregado = await Contact.create({ clinic: clinicId, phone: '593977000002', firstName: 'Hecho' });
  await Contact.create({ clinic: clinicId, phone: '593999111222', firstName: 'Nuevo' });

  // Estado que deja una PRUEBA: uno aún esperando su turno del goteo, otro ya salido.
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'waiting', nextRunAt: new Date(Date.now() + 7200e3),
    context: { phone: enCola.phone, contactId: String(enCola._id), eventType: 'contact_import', importBatchId: 'lote-viejo' },
  });
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'done',
    context: { phone: entregado.phone, contactId: String(entregado._id), eventType: 'contact_import', importBatchId: 'lote-viejo' },
  });

  const batch = await makeBatch(clinicId, userId, wf, { cancelPending: true });
  await enrollInWorkflows(batch, ['593999111222']);

  assert.equal(batch.enrollCancelled, 1);
  const previo = await WorkflowEnrollment.findOne({ 'context.phone': enCola.phone });
  assert.equal(previo.status, 'cancelled', 'el mensaje del Excel anterior ya no sale');
  assert.equal(previo.nextRunAt, null);
  const hecho = await WorkflowEnrollment.findOne({ 'context.phone': entregado.phone });
  assert.equal(hecho.status, 'done', 'lo ya enviado se queda como estaba');
});

test('sin cancelPending se respeta la cola anterior (reanudar un envío a medias)', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const previo = await Contact.create({ clinic: clinicId, phone: '593977000001', firstName: 'Previo' });
  await Contact.create({ clinic: clinicId, phone: '593999111222', firstName: 'Nuevo' });
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, status: 'waiting', nextRunAt: new Date(Date.now() + 7200e3),
    context: { phone: previo.phone, contactId: String(previo._id), eventType: 'contact_import', importBatchId: 'lote-viejo' },
  });

  const batch = await makeBatch(clinicId, userId, wf, { cancelPending: false });
  await enrollInWorkflows(batch, ['593999111222']);

  assert.equal(batch.enrollCancelled || 0, 0);
  assert.equal((await WorkflowEnrollment.findOne({ 'context.phone': previo.phone })).status, 'waiting');
});

test('cancelPending no toca las inscripciones de OTRO flujo', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  const otroFlujo = await Workflow.create({
    clinic: clinicId, name: 'Recordatorio de cita', active: true,
    trigger: { type: 'contact_import' }, steps: [{ type: 'send_message', body: 'Tu cita' }],
  });
  const c = await Contact.create({ clinic: clinicId, phone: '593977000001', firstName: 'Previo' });
  await Contact.create({ clinic: clinicId, phone: '593999111222', firstName: 'Nuevo' });
  await WorkflowEnrollment.create({
    clinic: clinicId, workflow: otroFlujo._id, status: 'waiting', nextRunAt: new Date(Date.now() + 7200e3),
    context: { phone: c.phone, contactId: String(c._id), eventType: 'contact_import', importBatchId: 'lote-viejo' },
  });

  const batch = await makeBatch(clinicId, userId, wf, { cancelPending: true });
  await enrollInWorkflows(batch, ['593999111222']);

  assert.equal(
    (await WorkflowEnrollment.findOne({ workflow: otroFlujo._id })).status,
    'waiting',
    'cancelar es por flujo: otra campaña en marcha no se ve afectada'
  );
});

// ─────────── 3. desde qué número sale ───────────

test('número FIJADO en el asistente: viaja al contexto de cada inscripción', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const qr = await WhatsappAccount.create({ label: 'QR Recepción', connectionType: 'qr', enabled: true });
  const wf = await unTrigger(clinicId);
  await Contact.create({ clinic: clinicId, phone: '593999111222', firstName: 'Ligia' });

  const batch = await makeBatch(clinicId, userId, wf, { whatsappAccount: qr._id });
  await enrollInWorkflows(batch, ['593999111222']);

  assert.equal((await WorkflowEnrollment.findOne({ workflow: wf._id })).context.whatsappAccountId, String(qr._id));
});

test('número AUTOMÁTICO: no se fija ninguno, lo decide el envío contacto a contacto', async () => {
  const { clinicId, userId } = await H.seedClinic();
  const wf = await unTrigger(clinicId);
  await Contact.create({ clinic: clinicId, phone: '593999111222', firstName: 'Ligia' });

  const batch = await makeBatch(clinicId, userId, wf);
  await enrollInWorkflows(batch, ['593999111222']);

  const e = await WorkflowEnrollment.findOne({ workflow: wf._id });
  assert.equal(e.context.whatsappAccountId, undefined, 'sin número fijado decide messaging, por conversación');
});
