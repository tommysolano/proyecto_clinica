/**
 * Nodo Condición con VARIAS condiciones y VARIAS ramas (estilo GoHighLevel):
 *
 *  - Cada rama tiene su propio conjunto de condiciones combinadas con Y (todas,
 *    "conectadas") u O (cualquiera, "independientes").
 *  - Las ramas se evalúan EN ORDEN (if / else-if): gana la primera que se cumple
 *    y el contacto sigue por su salida (sourceHandle = branch.id). Si no se
 *    cumple ninguna, sale por 'no' ("si no").
 *  - Pensado sobre todo para las ETAPAS DE OPORTUNIDAD del chat.
 *
 * Aquí se prueba el recorrido REAL del motor sobre el grafo, no solo el predicado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const engine = require('../utils/workflowEngine');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Conversation = require('../models/Conversation');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

// Condición de 2 ramas por etapa: "ganado" → rama-ganado, "agendado o
// interesado" → rama-agendado; si no → rama-otras.
const branchWorkflow = (clinicId) => Workflow.create({
  clinic: clinicId,
  name: 'Condición multi-rama',
  active: true,
  triggers: [{ type: 'opportunity_stage', audience: 'all' }],
  nodes: [
    { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'opportunity_stage' }] } },
    {
      id: 'cond',
      type: 'condition',
      position: { x: 0, y: 130 },
      data: {
        branches: [
          { id: 'yes', name: 'Ganado', match: 'all', conditions: [{ id: 'c1', field: 'stage', op: 'eq', value: 'ganado' }] },
          { id: 'b2', name: 'En curso', match: 'all', conditions: [{ id: 'c2', field: 'stage', op: 'in', values: ['agendado', 'interesado'] }] },
        ],
      },
    },
    { id: 'tg', type: 'add_tag', position: { x: -240, y: 260 }, data: { tag: 'rama-ganado' } },
    { id: 'ta', type: 'add_tag', position: { x: 0, y: 260 }, data: { tag: 'rama-agendado' } },
    { id: 'to', type: 'add_tag', position: { x: 240, y: 260 }, data: { tag: 'rama-otras' } },
  ],
  edges: [
    { id: 'e0', source: 'trigger', target: 'cond', sourceHandle: 'default' },
    { id: 'e1', source: 'cond', target: 'tg', sourceHandle: 'yes' },
    { id: 'e2', source: 'cond', target: 'ta', sourceHandle: 'b2' },
    { id: 'e3', source: 'cond', target: 'to', sourceHandle: 'no' },
  ],
});

async function runCondition(wf, clinicId, patientId, conversationId, context = {}) {
  const enr = await WorkflowEnrollment.create({
    clinic: clinicId,
    workflow: wf._id,
    patient: patientId,
    conversation: conversationId,
    currentNodeId: 'cond',
    startNodeId: 'trigger',
    status: 'active',
    context,
  });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
  return WorkflowEnrollment.findById(enr._id);
}

test('las ramas se evalúan en orden y cada etapa toma su propia salida', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Ana', lastName: 'V', phone: '0991234567' });
  const conv = await Conversation.create({
    clinic: clinic._id,
    phone: '593991234567',
    channel: 'whatsapp',
    patient: patient._id,
    opportunities: [{ isOpportunity: true, stage: 'agendado' }],
  });
  const wf = await branchWorkflow(clinic._id);

  // Etapa "agendado" → 2ª rama ("es alguno de agendado/interesado").
  let enr = await runCondition(wf, clinic._id, patient._id, conv._id, { phone: '593991234567' });
  assert.equal(enr.status, 'done');
  let tags = (await Patient.findById(patient._id).lean()).tags || [];
  assert.ok(tags.includes('rama-agendado'), 'siguió la rama "En curso"');
  assert.ok(!tags.includes('rama-ganado') && !tags.includes('rama-otras'));
  assert.ok((enr.log || []).some((l) => l.type === 'condition' && /Rama En curso/.test(l.info)), 'el registro nombra la rama');

  // La oportunidad pasa a "ganado" → 1ª rama.
  await Conversation.updateOne({ _id: conv._id }, { $set: { 'opportunities.0.stage': 'ganado' } });
  await Patient.updateOne({ _id: patient._id }, { $set: { tags: [] } });
  enr = await runCondition(wf, clinic._id, patient._id, conv._id, { phone: '593991234567' });
  tags = (await Patient.findById(patient._id).lean()).tags || [];
  assert.ok(tags.includes('rama-ganado'), 'siguió la rama "Ganado"');

  // Etapa que no cumple ninguna rama → salida "si no".
  await Conversation.updateOne({ _id: conv._id }, { $set: { 'opportunities.0.stage': 'perdido' } });
  await Patient.updateOne({ _id: patient._id }, { $set: { tags: [] } });
  enr = await runCondition(wf, clinic._id, patient._id, conv._id, { phone: '593991234567' });
  tags = (await Patient.findById(patient._id).lean()).tags || [];
  assert.ok(tags.includes('rama-otras'), 'sin rama que se cumpla → salida "si no"');
  assert.ok((enr.log || []).some((l) => l.type === 'condition' && /si no/i.test(l.info)));
});

test('condiciones conectadas (Y) y independientes (O) dentro de una rama', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Leo', lastName: 'M', phone: '0990000000', tags: ['vip'] });
  const conv = await Conversation.create({
    clinic: clinic._id,
    phone: '593990000000',
    channel: 'whatsapp',
    patient: patient._id,
    opportunities: [{ isOpportunity: true, stage: 'agendado', expectedValue: 900 }],
  });

  const make = (match, conditions) => Workflow.create({
    clinic: clinic._id, name: `Cond ${match}`, active: true,
    triggers: [{ type: 'opportunity_stage', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'opportunity_stage' }] } },
      { id: 'cond', type: 'condition', position: { x: 0, y: 130 }, data: { branches: [{ id: 'yes', name: 'Sí', match, conditions }] } },
      { id: 'ty', type: 'add_tag', position: { x: -120, y: 260 }, data: { tag: 'cumple' } },
      { id: 'tn', type: 'add_tag', position: { x: 120, y: 260 }, data: { tag: 'no-cumple' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'cond', sourceHandle: 'default' },
      { id: 'e1', source: 'cond', target: 'ty', sourceHandle: 'yes' },
      { id: 'e2', source: 'cond', target: 'tn', sourceHandle: 'no' },
    ],
  });

  const tagsAfter = async (wf) => {
    await Patient.updateOne({ _id: patient._id }, { $set: { tags: ['vip'] } });
    await runCondition(wf, clinic._id, patient._id, conv._id, { phone: '593990000000' });
    return (await Patient.findById(patient._id).lean()).tags || [];
  };

  // Y: etapa agendada + etiqueta vip + valor > 500 → las tres se cumplen.
  const yTodas = await make('all', [
    { id: 'a', field: 'stage', op: 'eq', value: 'agendado' },
    { id: 'b', field: 'tag', op: 'eq', value: 'vip' },
    { id: 'c', field: 'opportunityValue', op: 'gt', value: '500' },
  ]);
  assert.ok((await tagsAfter(yTodas)).includes('cumple'), 'Y: se cumplen todas');

  // Y: basta con que UNA falle para irse por la rama "no".
  const yFalla = await make('all', [
    { id: 'a', field: 'stage', op: 'eq', value: 'agendado' },
    { id: 'b', field: 'tag', op: 'eq', value: 'inexistente' },
  ]);
  assert.ok((await tagsAfter(yFalla)).includes('no-cumple'), 'Y: una falla → no se cumple');

  // O: la primera falla pero la segunda se cumple → sigue la rama.
  const oUna = await make('any', [
    { id: 'a', field: 'stage', op: 'eq', value: 'perdido' },
    { id: 'b', field: 'tag', op: 'eq', value: 'vip' },
  ]);
  assert.ok((await tagsAfter(oUna)).includes('cumple'), 'O: basta con una');
});

test('GET /workflows/tags devuelve las etiquetas EN USO por familia (para los desplegables)', async () => {
  const workflowCtrl = require('../controllers/workflowController');
  const mongoose = require('mongoose');
  const clinic = await Clinic.create({ name: 'Principal' });
  const userId = new mongoose.Types.ObjectId();

  await Patient.create({ clinic: clinic._id, firstName: 'Ana', lastName: 'V', phone: '0991234567', tags: ['vip', 'ortodoncia'] });
  await Conversation.create({
    clinic: clinic._id,
    phone: '593991234567',
    channel: 'whatsapp',
    tags: ['seguimiento'],
    opportunities: [{ isOpportunity: true, stage: 'agendado', tags: ['botox', 'promo-mayo'] }],
  });

  const res = await H.runController(workflowCtrl.listTags, H.mockReq(clinic._id, userId, {}, { role: 'admin' }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.payload.patient, ['ortodoncia', 'vip']); // ordenadas alfabéticamente
  assert.deepEqual(res.payload.chat, ['seguimiento']);
  assert.deepEqual(res.payload.opportunity, ['botox', 'promo-mayo']);
});

test('un nodo condición ANTIGUO (field/op/value, salidas sí/no) sigue funcionando', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Sara', lastName: 'P', phone: '0991112223', tags: ['vip'] });
  const wf = await Workflow.create({
    clinic: clinic._id, name: 'Condición legacy', active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      { id: 'cond', type: 'condition', position: { x: 0, y: 130 }, data: { field: 'tag', op: 'eq', value: 'vip' } },
      { id: 'ty', type: 'add_tag', position: { x: -120, y: 260 }, data: { tag: 'era-vip' } },
      { id: 'tn', type: 'add_tag', position: { x: 120, y: 260 }, data: { tag: 'no-era-vip' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'cond', sourceHandle: 'default' },
      { id: 'e1', source: 'cond', target: 'ty', sourceHandle: 'yes' },
      { id: 'e2', source: 'cond', target: 'tn', sourceHandle: 'no' },
    ],
  });

  await runCondition(wf, clinic._id, patient._id, null, {});
  const tags = (await Patient.findById(patient._id).lean()).tags || [];
  assert.ok(tags.includes('era-vip'), 'la condición de una sola rama sigue saliendo por "sí"');
  assert.ok(!tags.includes('no-era-vip'));
});
