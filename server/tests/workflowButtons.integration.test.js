const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const engine = require('../utils/workflowEngine');
const messaging = require('../utils/messaging');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

const realSend = messaging.send;
const realPublicApiUrl = process.env.PUBLIC_API_URL;

test.before(async () => { await H.startDb(); });
test.after(async () => {
  messaging.send = realSend;
  if (realPublicApiUrl === undefined) delete process.env.PUBLIC_API_URL;
  else process.env.PUBLIC_API_URL = realPublicApiUrl;
  await H.stopDb();
});
test.beforeEach(async () => {
  await H.resetDb();
  messaging.send = realSend;
  process.env.PUBLIC_API_URL = 'https://app.example.test';
});

// `withDefaultExit: false` reproduce el diagrama que rompió producción: el nodo
// solo tiene conectada la salida del botón, sin la de "otra respuesta / tiempo".
async function seed(buttons, { nodeType = 'send_message', withDefaultExit = true } = {}) {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({
    clinic: clinic._id,
    firstName: 'Ana',
    lastName: 'Botones',
    phone: '0991234567',
  });
  const workflow = await Workflow.create({
    clinic: clinic._id,
    name: 'Ramas por botón',
    active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      {
        id: 'msg',
        type: nodeType,
        position: { x: 0, y: 130 },
        data: {
          body: 'Elige',
          templateName: nodeType === 'send_template' ? 'confirmacion_cita' : '',
          templateLanguage: 'es',
          buttons,
          buttonTimeoutMinutes: 60,
        },
      },
      { id: 'clicked', type: 'add_tag', position: { x: -100, y: 260 }, data: { tag: 'boton-pulsado' } },
      { id: 'fallback', type: 'add_tag', position: { x: 100, y: 260 }, data: { tag: 'sin-boton' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'msg', sourceHandle: 'default' },
      { id: 'e1', source: 'msg', target: 'clicked', sourceHandle: buttons[0].id },
      ...(withDefaultExit
        ? [{ id: 'e2', source: 'msg', target: 'fallback', sourceHandle: 'default' }]
        : []),
    ],
  });
  const enrollment = await WorkflowEnrollment.create({
    clinic: clinic._id,
    workflow: workflow._id,
    patient: patient._id,
    currentNodeId: 'msg',
    startNodeId: 'trigger',
    status: 'active',
    context: { phone: patient.phone },
  });
  return { clinic, patient, workflow, enrollment };
}

test('respuesta rápida: envía payload único y continúa por la salida del botón', async () => {
  const data = await seed([{ id: 'confirmar', type: 'quick_reply', text: 'Confirmar', url: '' }]);
  let sentButtons = [];
  messaging.send = async (payload) => {
    sentButtons = payload.buttons;
    return { ok: true, deliveryStatus: 'sent' };
  };

  await engine.executeEnrollment(await WorkflowEnrollment.findById(data.enrollment._id));
  let waiting = await WorkflowEnrollment.findById(data.enrollment._id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waitingForReply, true);
  assert.equal(waiting.currentNodeId, 'fallback', 'el timeout queda preparado en la salida default');
  assert.match(sentButtons[0].providerId, new RegExp(`^wf:${data.enrollment._id}:confirmar$`));

  const result = await engine.resumeOnReply({
    clinicId: data.clinic._id,
    patientId: data.patient._id,
    phone: data.patient.phone,
    text: 'Confirmar',
    interactiveReply: { id: sentButtons[0].providerId, title: 'Confirmar', type: 'button_reply' },
  });
  assert.equal(result.resumed, 1);
  waiting = await WorkflowEnrollment.findById(data.enrollment._id);
  assert.equal(waiting.status, 'done');
  const patient = await Patient.findById(data.patient._id).lean();
  assert.ok(patient.tags.includes('boton-pulsado'));
  assert.ok(!patient.tags.includes('sin-boton'));

});

test('tiempo agotado: continúa por la salida Otra / tiempo', async () => {
  const data = await seed([{ id: 'confirmar', type: 'quick_reply', text: 'Confirmar', url: '' }]);
  messaging.send = async () => ({ ok: true, deliveryStatus: 'sent' });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(data.enrollment._id));

  await WorkflowEnrollment.updateOne(
    { _id: data.enrollment._id },
    { nextRunAt: new Date(Date.now() - 1000) }
  );
  await engine.executeEnrollment(await WorkflowEnrollment.findById(data.enrollment._id));
  const patient = await Patient.findById(data.patient._id).lean();
  assert.ok(patient.tags.includes('sin-boton'));
  assert.ok(!patient.tags.includes('boton-pulsado'));
});

test('plantilla: una respuesta rápida aprobada espera y continúa por su salida', async () => {
  const data = await seed(
    [{ id: 'tpl_confirmar', type: 'quick_reply', text: 'Confirmar', url: '' }],
    { nodeType: 'send_template' }
  );
  let sentPayload = null;
  messaging.send = async (payload) => {
    sentPayload = payload;
    return { ok: true, deliveryStatus: 'sent' };
  };

  await engine.executeEnrollment(await WorkflowEnrollment.findById(data.enrollment._id));
  let waiting = await WorkflowEnrollment.findById(data.enrollment._id);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.waitingForReply, true);
  assert.equal(waiting.currentNodeId, 'fallback');
  assert.equal(sentPayload.template.name, 'confirmacion_cita');
  assert.equal(sentPayload.buttons, undefined, 'los botones ya forman parte de la plantilla aprobada en Meta');

  const result = await engine.resumeOnReply({
    clinicId: data.clinic._id,
    patientId: data.patient._id,
    phone: data.patient.phone,
    text: 'Confirmar',
    interactiveReply: { id: 'meta-template-payload', title: 'Confirmar', type: 'button_reply' },
  });
  assert.equal(result.resumed, 1);
  waiting = await WorkflowEnrollment.findById(data.enrollment._id);
  assert.equal(waiting.status, 'done');
  const patient = await Patient.findById(data.patient._id).lean();
  assert.ok(patient.tags.includes('boton-pulsado'));
  assert.ok(!patient.tags.includes('sin-boton'));
});

// ── Sin salida "otra respuesta / tiempo" conectada ──
// El fallo de producción (ago-2026, flujo "24 horas"): la inscripción quedaba
// esperando con currentNodeId a null, el motor lo tomaba por "aún no ha empezado"
// y REENVIABA la plantilla —cobrada por Meta— con CADA mensaje del paciente.
test('botón sin salida "otra respuesta": una respuesta libre cierra el flujo y NO reenvía', async () => {
  const data = await seed(
    [{ id: 'tb_msg_1', type: 'quick_reply', text: 'Si asistire', url: '' }],
    { nodeType: 'send_template', withDefaultExit: false }
  );
  let envios = 0;
  messaging.send = async () => { envios += 1; return { ok: true, deliveryStatus: 'sent' }; };

  await engine.executeEnrollment(await WorkflowEnrollment.findById(data.enrollment._id));
  assert.equal(envios, 1);
  let enr = await WorkflowEnrollment.findById(data.enrollment._id);
  assert.equal(enr.status, 'waiting');
  assert.equal(enr.currentNodeId, null, 'la salida "otra respuesta" no lleva a ningún paso');

  // El paciente escribe cualquier otra cosa: tres veces seguidas, como en el caso real.
  for (const texto of ['Ok.... Y el Papanicolaou?', 'El pap, también?', 'Ok gracias']) {
    // eslint-disable-next-line no-await-in-loop
    await engine.resumeOnReply({
      clinicId: data.clinic._id,
      patientId: data.patient._id,
      phone: data.patient.phone,
      text: texto,
    });
  }
  assert.equal(envios, 1, 'la plantilla salió UNA vez, por muchos mensajes que escriba');
  enr = await WorkflowEnrollment.findById(data.enrollment._id);
  assert.equal(enr.status, 'done');
  assert.equal(enr.waitingForReply, false);
  assert.ok(enr.log.some((l) => l.type === 'end'), 'queda escrito por qué terminó');
  const patient = await Patient.findById(data.patient._id).lean();
  assert.ok(!patient.tags.includes('sin-boton'));
});

test('botón sin salida "otra respuesta": el vencimiento del plazo tampoco reenvía', async () => {
  const data = await seed(
    [{ id: 'tb_msg_1', type: 'quick_reply', text: 'Si asistire', url: '' }],
    { withDefaultExit: false }
  );
  let envios = 0;
  messaging.send = async () => { envios += 1; return { ok: true, deliveryStatus: 'sent' }; };
  await engine.executeEnrollment(await WorkflowEnrollment.findById(data.enrollment._id));

  await WorkflowEnrollment.updateOne(
    { _id: data.enrollment._id },
    { nextRunAt: new Date(Date.now() - 1000) }
  );
  const { processed } = await engine.processDueEnrollments();
  assert.equal(processed, 1);
  assert.equal(envios, 1, 'al vencer el plazo el flujo termina, no vuelve al disparador');
  const enr = await WorkflowEnrollment.findById(data.enrollment._id);
  assert.equal(enr.status, 'done');
});

test('botón sin salida "otra respuesta": pulsarlo sí continúa por su rama', async () => {
  const data = await seed(
    [{ id: 'tb_msg_1', type: 'quick_reply', text: 'Si asistire', url: '' }],
    { withDefaultExit: false }
  );
  messaging.send = async () => ({ ok: true, deliveryStatus: 'sent' });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(data.enrollment._id));

  await engine.resumeOnReply({
    clinicId: data.clinic._id,
    patientId: data.patient._id,
    phone: data.patient.phone,
    text: 'Si asistire',
    interactiveReply: { id: `wf:${data.enrollment._id}:tb_msg_1`, title: 'Si asistire', type: 'button_reply' },
  });
  const enr = await WorkflowEnrollment.findById(data.enrollment._id);
  assert.equal(enr.status, 'done');
  const patient = await Patient.findById(data.patient._id).lean();
  assert.ok(patient.tags.includes('boton-pulsado'));
});

test('botón de enlace: registra el clic, ejecuta su rama y devuelve el destino', async () => {
  const data = await seed([{ id: 'ver_web', type: 'url', text: 'Ver sitio', url: 'https://shiluv.example/promo' }]);
  let sentButtons = [];
  messaging.send = async (payload) => {
    sentButtons = payload.buttons;
    return { ok: true, deliveryStatus: 'sent' };
  };
  await engine.executeEnrollment(await WorkflowEnrollment.findById(data.enrollment._id));

  assert.match(sentButtons[0].providerUrl, /^https:\/\/app\.example\.test\/api\/public\/workflow-buttons\//);
  const token = sentButtons[0].providerUrl.split('/').pop();
  const click = await engine.resumeOnButtonClick(token);
  assert.equal(click.found, true);
  assert.equal(click.resumed, true);
  assert.equal(click.destination, 'https://shiluv.example/promo');
  const patient = await Patient.findById(data.patient._id).lean();
  assert.ok(patient.tags.includes('boton-pulsado'));
  assert.ok(!patient.tags.includes('sin-boton'));

  // El enlace sigue abriendo su destino si se pulsa otra vez, pero la acción
  // del workflow es idempotente y no vuelve a ejecutarse.
  const repeated = await engine.resumeOnButtonClick(token);
  assert.equal(repeated.found, true);
  assert.equal(repeated.resumed, false);
  assert.equal(repeated.destination, 'https://shiluv.example/promo');
});
