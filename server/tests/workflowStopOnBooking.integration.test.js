/**
 * La promoción se DETIENE cuando el contacto agenda.
 *
 * Caso real (ago-2026): una automatización con esperas de 15 h seguía su curso
 * después de que el paciente agendara y le llegaba "¿te gustaría agendar tu
 * cita?" con la cita ya en la agenda. Se corta al entrar la oportunidad en
 * 'agendado' / 'ganado', salvo en los flujos hechos PARA quien ya agendó.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const H = require('./_integrationHelpers');
const engine = require('../utils/workflowEngine');

const Conversation = require('../models/Conversation');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

const TEL = '593999111222';

/**
 * Retrasa el `createdAt` de una inscripción. Va por el driver (`.collection`) a
 * propósito: mongoose descarta el $set de `createdAt` —también con
 * `timestamps: false`— y lo dejaría en "ahora", que es justo lo contrario de lo
 * que estos casos necesitan.
 */
const backdate = (id, ms) => WorkflowEnrollment.collection.updateOne(
  { _id: new mongoose.Types.ObjectId(String(id)) },
  { $set: { createdAt: new Date(Date.now() - ms) } }
);

async function seed({ stopOnBooking = true, hace = 60 * 60 * 1000 } = {}) {
  const clinicId = new mongoose.Types.ObjectId();
  const conv = await Conversation.create({ clinic: clinicId, phone: TEL, channel: 'whatsapp' });
  const wf = await Workflow.create({
    clinic: clinicId,
    name: 'Promo protocolo facial',
    active: true,
    stopOnBooking,
    triggers: [{ type: 'ctwa_ad' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'ctwa_ad' }] } },
      { id: 'esperar', type: 'wait', position: { x: 0, y: 130 }, data: { waitMinutes: 900 } },
      { id: 'msg', type: 'send_message', position: { x: 0, y: 260 }, data: { body: '¿Te gustaría agendar tu cita?' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'esperar', sourceHandle: 'default' },
      { id: 'e1', source: 'esperar', target: 'msg', sourceHandle: 'default' },
    ],
  });
  const enr = await WorkflowEnrollment.create({
    clinic: clinicId,
    workflow: wf._id,
    conversation: conv._id,
    currentNodeId: 'msg',
    startNodeId: 'trigger',
    status: 'waiting',
    nextRunAt: new Date(Date.now() + 15 * 3600e3),
    context: { phone: TEL },
  });
  // Se retrasa su creación para simular una promoción que lleva viva un rato
  // (el margen anti-carrera mira justo eso).
  await backdate(enr._id, hace);
  return { clinicId, conv, wf, enr };
}

const agenda = (data, stage = 'agendado') => engine.cancelEnrollmentsOnBooking({
  clinicId: String(data.clinicId),
  conversationId: String(data.conv._id),
  phone: TEL,
  stage,
});

test('agendar detiene la promoción en curso y deja escrito el porqué', async () => {
  const data = await seed();
  const { cancelled } = await agenda(data);
  assert.equal(cancelled, 1);
  const enr = await WorkflowEnrollment.findById(data.enr._id);
  assert.equal(enr.status, 'cancelled');
  const stop = enr.log.find((l) => l.type === 'stop');
  assert.ok(stop, 'el registro explica que se detuvo por haber agendado');
  assert.match(stop.info, /agendado/);
});

test('"Ganado" también detiene; "interesado" no', async () => {
  const ganado = await seed();
  assert.equal((await agenda(ganado, 'ganado')).cancelled, 1);

  const interesado = await seed();
  assert.equal((await agenda(interesado, 'interesado')).cancelled, 0);
  assert.equal((await WorkflowEnrollment.findById(interesado.enr._id)).status, 'waiting');
});

test('un flujo marcado "seguir enviando aunque agende" no se detiene', async () => {
  const data = await seed({ stopOnBooking: false });
  assert.equal((await agenda(data)).cancelled, 0);
  assert.equal((await WorkflowEnrollment.findById(data.enr._id)).status, 'waiting');
});

test('no mata lo que ese mismo agendamiento acaba de inscribir', async () => {
  // El flujo "cuando agenda una cita → mándale la preparación" se inscribe en el
  // mismo instante que se emite el cambio de etapa: no debe cancelarse a sí mismo.
  const data = await seed({ hace: 2000 });
  assert.equal((await agenda(data)).cancelled, 0);
  assert.equal((await WorkflowEnrollment.findById(data.enr._id)).status, 'waiting');
});

test('solo toca al contacto que agendó', async () => {
  const data = await seed();
  const otra = await Conversation.create({ clinic: data.clinicId, phone: '593988000111', channel: 'whatsapp' });
  const ajena = await WorkflowEnrollment.create({
    clinic: data.clinicId,
    workflow: data.wf._id,
    conversation: otra._id,
    currentNodeId: 'msg',
    status: 'waiting',
    nextRunAt: new Date(Date.now() + 15 * 3600e3),
    context: { phone: otra.phone },
  });
  await backdate(ajena._id, 3600e3);

  assert.equal((await agenda(data)).cancelled, 1);
  assert.equal((await WorkflowEnrollment.findById(ajena._id)).status, 'waiting');
});
