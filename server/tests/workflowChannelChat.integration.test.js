/**
 * Las automatizaciones (workflows) disparadas desde un chat de Messenger o
 * Instagram deben responder por ESE MISMO canal, no por WhatsApp.
 *
 * Antes `executeEnrollment` ignoraba `enrollment.conversation` (que
 * enrollForChatMessage/enrollForOpportunityStage YA guardan con la conversación
 * exacta que disparó el flujo) y volvía a adivinarla por teléfono vía
 * `loadConversationForPatient`, que fuerza `channel: 'whatsapp'` cuando el
 * contacto es paciente. Resultado real: un paciente que escribía por Messenger
 * pero también tenía un chat viejo de WhatsApp recibía la auto-respuesta por
 * WhatsApp (o el envío fallaba, al usar el PSID como si fuera un teléfono).
 *
 * También cubre el paso "Enviar plantilla": Meta no tiene HSM fuera de
 * WhatsApp, pero SÍ se puede mandar el TEXTO de la plantilla como mensaje
 * normal por Messenger/Instagram (igual que ya hacían los números QR de
 * WhatsApp, que tampoco admiten HSM) — funciona en Instagram, falla claro en
 * un canal de verdad sin soporte (TikTok, que ni siquiera es de Meta).
 *
 * Se mockea `fetch` global — no se llama a Meta de verdad.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');

const Conversation = require('../models/Conversation');
const CallCenterConfig = require('../models/CallCenterConfig');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');
const Patient = require('../models/Patient');
const MessageTemplate = require('../models/MessageTemplate');
const { encryptSecret } = require('../utils/secretCrypto');
const workflowEngine = require('../utils/workflowEngine');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function seedChannel(clinicId, channel) {
  await CallCenterConfig.create({
    clinic: clinicId,
    [channel]: { enabled: true, pageId: 'PAGE1', pageAccessToken: encryptSecret('PAGE_TOKEN_123'), verifyToken: 'v', appSecret: 's' },
  });
}

function installFetchMock(responder) {
  const calls = [];
  const original = global.fetch;
  global.fetch = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ url, body });
    return responder(body, calls.length);
  };
  return { calls, restore: () => { global.fetch = original; } };
}

function keywordTrigger() {
  return { type: 'keyword', keywords: ['precio'], matchType: 'contains', audience: 'all' };
}

function keywordWorkflow(clinicId, { body = 'Gracias por escribirnos, un asesor te contactará.' } = {}) {
  return Workflow.create({
    clinic: clinicId,
    name: 'Auto-respuesta',
    active: true,
    triggers: [keywordTrigger()],
    trigger: keywordTrigger(),
    steps: [],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [keywordTrigger()] } },
      { id: 'n1', type: 'send_message', position: { x: 0, y: 130 }, data: { body } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1', sourceHandle: 'default' }],
  });
}

function templateWorkflow(clinicId) {
  const tr = { type: 'keyword', keywords: ['plantilla'], matchType: 'contains', audience: 'all' };
  return Workflow.create({
    clinic: clinicId,
    name: 'Plantilla',
    active: true,
    triggers: [tr],
    trigger: tr,
    steps: [],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [tr] } },
      { id: 'n1', type: 'send_template', position: { x: 0, y: 130 }, data: { templateName: 'saludo', templateLanguage: 'es' } },
    ],
    edges: [{ id: 'e1', source: 'trigger', target: 'n1', sourceHandle: 'default' }],
  });
}

test('keyword desde un chat de Messenger: la auto-respuesta sale por MESSENGER (Send API de Meta), no por WhatsApp', async () => {
  const { clinicId } = await H.seedClinic();
  await seedChannel(clinicId, 'messenger');
  const conv = await Conversation.create({
    clinic: clinicId, phone: '7000800090001000', externalUserId: '7000800090001000', channel: 'messenger',
  });
  const wf = await keywordWorkflow(clinicId);

  const mock = installFetchMock(async () => ({ ok: true, json: async () => ({ recipient_id: 'PSID', message_id: 'mid_1' }) }));
  try {
    await workflowEngine.enrollForChatMessage({
      clinicId, conversation: conv, patient: null, phone: conv.phone, text: 'cuánto cuesta el precio', isNew: false,
    });
    const enrollment = await WorkflowEnrollment.findOne({ workflow: wf._id, conversation: conv._id });
    assert.ok(enrollment, 'no se creó la inscripción');
    assert.equal(enrollment.status, 'done');
    const log = (enrollment.log || []).find((l) => l.type === 'send_message');
    assert.ok(log, 'sin rastro del paso send_message');
    assert.equal(log.ok, true, JSON.stringify(log));

    // Si el paso hubiera vuelto a caer en WhatsApp (sin gateway configurado en
    // el test), no habría llamada a Meta y el log habría quedado en ok:false.
    assert.equal(mock.calls.length, 1, 'debe llamar UNA vez al Send API de Meta (Messenger)');
    assert.match(mock.calls[0].url, /graph\.facebook\.com/);
    assert.equal(mock.calls[0].body.recipient.id, conv.externalUserId);
    assert.equal(mock.calls[0].body.messaging_type, 'RESPONSE');
  } finally {
    mock.restore();
  }
});

test('paciente con chat de WhatsApp Y de Messenger: el flujo disparado por Messenger responde por Messenger, no por el WhatsApp guardado en su ficha', async () => {
  const { clinicId } = await H.seedClinic();
  await seedChannel(clinicId, 'messenger');
  const patient = await Patient.create({ clinic: clinicId, firstName: 'Ana', lastName: 'Vera', phone: '0991234567' });
  // Chat viejo de WhatsApp del mismo paciente: antes del fix, loadConversationForPatient
  // lo encontraba PRIMERO (fuerza channel:'whatsapp' cuando hay patientId) e ignoraba
  // por completo el chat de Messenger que en realidad disparó este flujo.
  await Conversation.create({ clinic: clinicId, phone: '0991234567', channel: 'whatsapp', patient: patient._id });
  const conv = await Conversation.create({
    clinic: clinicId, phone: '7000800090002000', externalUserId: '7000800090002000', channel: 'messenger', patient: patient._id,
  });
  await keywordWorkflow(clinicId);

  const mock = installFetchMock(async () => ({ ok: true, json: async () => ({ recipient_id: 'PSID', message_id: 'mid_2' }) }));
  try {
    await workflowEngine.enrollForChatMessage({
      clinicId, conversation: conv, patient, phone: conv.phone, text: 'precio', isNew: false,
    });
    // No hay WhatsApp gateway configurado en el test: si el paso hubiera intentado
    // enviar por WhatsApp, la llamada a Meta jamás habría ocurrido (0 calls).
    assert.equal(mock.calls.length, 1, 'debió responder por Messenger (el chat que disparó el flujo), no por el WhatsApp de la ficha');
    assert.equal(mock.calls[0].body.recipient.id, conv.externalUserId);
  } finally {
    mock.restore();
  }
});

test('paso "Enviar plantilla" en un chat de Instagram: manda el TEXTO de la plantilla como mensaje normal (Meta no tiene HSM ahí)', async () => {
  const { clinicId } = await H.seedClinic();
  await seedChannel(clinicId, 'instagram');
  const conv = await Conversation.create({
    clinic: clinicId, phone: '7000800090003000', externalUserId: '7000800090003000', channel: 'instagram',
  });
  await MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: 'saludo', status: 'approved',
    body: 'Gracias por tu mensaje, un asesor te contactará pronto.',
  });
  const wf = await templateWorkflow(clinicId); // templateName: 'saludo'

  const mock = installFetchMock(async () => ({ ok: true, json: async () => ({ recipient_id: 'IGSID', message_id: 'mid_3' }) }));
  try {
    await workflowEngine.enrollForChatMessage({
      clinicId, conversation: conv, patient: null, phone: conv.phone, text: 'quiero la plantilla', isNew: false,
    });
    const enrollment = await WorkflowEnrollment.findOne({ workflow: wf._id, conversation: conv._id });
    assert.ok(enrollment);
    const log = (enrollment.log || []).find((l) => l.type === 'send_template');
    assert.ok(log, 'sin rastro del paso send_template');
    assert.equal(log.ok, true, JSON.stringify(log));

    assert.equal(mock.calls.length, 1, 'debe llamar UNA vez al Send API de Meta (Instagram), sin HSM');
    assert.equal(mock.calls[0].body.message.text, 'Gracias por tu mensaje, un asesor te contactará pronto.');
    assert.equal(mock.calls[0].body.recipient.id, conv.externalUserId);
    // Instagram no manda messaging_type (a diferencia de Messenger).
    assert.equal(mock.calls[0].body.messaging_type, undefined);
  } finally {
    mock.restore();
  }
});

test('paso "Enviar plantilla" en un chat de TikTok falla claro: canal sin envío implementado (no es de Meta)', async () => {
  const { clinicId } = await H.seedClinic();
  const conv = await Conversation.create({
    clinic: clinicId, phone: 'tiktok_open_id_1', externalUserId: 'tiktok_open_id_1', channel: 'tiktok',
  });
  await MessageTemplate.create({
    clinic: clinicId, channel: 'whatsapp', name: 'saludo', status: 'approved',
    body: 'Gracias por tu mensaje.',
  });
  const wf = await templateWorkflow(clinicId);

  const mock = installFetchMock(async () => { throw new Error('no debería llamarse a Meta'); });
  try {
    await workflowEngine.enrollForChatMessage({
      clinicId, conversation: conv, patient: null, phone: conv.phone, text: 'quiero la plantilla', isNew: false,
    });
    const enrollment = await WorkflowEnrollment.findOne({ workflow: wf._id, conversation: conv._id });
    assert.ok(enrollment);
    const log = (enrollment.log || []).find((l) => l.type === 'send_template');
    assert.ok(log, 'sin rastro del paso send_template');
    assert.equal(log.ok, false);
    assert.match(log.info, /no están disponibles/i);
    assert.equal(mock.calls.length, 0, 'no debe intentar llamar a Meta con una plantilla por TikTok');
  } finally {
    mock.restore();
  }
});
