/**
 * LA CONDICIÓN SE VUELVE A COMPROBAR AL DESPERTAR (oct-2026).
 *
 * Caso real (flujo ANTI AGE, 20-10-2026): la condición mandó al contacto por la
 * rama «Nuevo»; cuatro minutos después la asesora pasó la oportunidad a «Perdido»
 * y, aun así, la rama siguió enviando sus recordatorios tras cada espera (2 h,
 * 4 h, 10 h). Al reanudarse tras una espera la condición se vuelve a mirar: si
 * ahora toca otra rama, el contacto se va a ella — o sale si esa salida no lleva a
 * ningún paso. Lo que cambia el PROPIO flujo no cuenta como cambio.
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

const espera = (id) => ({ id, type: 'wait', position: { x: 0, y: 0 }, data: { waitMinutes: 120 } });
const etiqueta = (id, tag) => ({ id, type: 'add_tag', position: { x: 0, y: 0 }, data: { tag } });

/** Condición Nuevo / Agendado (el «si no» sin conectar, como en la captura). */
function flujo(clinicId, { recheck, pasosNuevo, aristasNuevo } = {}) {
  return Workflow.create({
    clinic: clinicId,
    name: 'ANTI AGE',
    active: true,
    triggers: [{ type: 'opportunity_stage', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'opportunity_stage' }] } },
      {
        id: 'cond', type: 'condition', position: { x: 0, y: 0 },
        data: {
          ...(recheck === undefined ? {} : { recheck }),
          branches: [
            { id: 'yes', name: 'Nuevo', match: 'all', conditions: [{ id: 'c1', field: 'stage', op: 'eq', value: 'nuevo' }] },
            { id: 'b2', name: 'Agendado', match: 'all', conditions: [{ id: 'c2', field: 'stage', op: 'eq', value: 'agendado' }] },
          ],
        },
      },
      ...(pasosNuevo || [espera('w1'), etiqueta('m1', 'recordatorio-1'), espera('w2'), etiqueta('m2', 'recordatorio-2')]),
      etiqueta('ag', 'rama-agendado'),
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'cond', sourceHandle: 'default' },
      ...(aristasNuevo || [
        { id: 'e1', source: 'cond', target: 'w1', sourceHandle: 'yes' },
        { id: 'e2', source: 'w1', target: 'm1' },
        { id: 'e3', source: 'm1', target: 'w2' },
        { id: 'e4', source: 'w2', target: 'm2' },
      ]),
      { id: 'e5', source: 'cond', target: 'ag', sourceHandle: 'b2' },
    ],
  });
}

async function escenario(opts) {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Ana', lastName: 'V', phone: '0991234567' });
  const conv = await Conversation.create({
    clinic: clinic._id, phone: '593991234567', channel: 'whatsapp', patient: patient._id,
    opportunities: [{ isOpportunity: true, name: 'Anti-age', stage: 'nuevo' }],
  });
  const wf = await flujo(clinic._id, opts);
  const enr = await WorkflowEnrollment.create({
    clinic: clinic._id, workflow: wf._id, patient: patient._id, conversation: conv._id,
    currentNodeId: 'cond', startNodeId: 'trigger', status: 'active', context: { phone: '593991234567' },
  });
  const correr = async () => {
    await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
    return WorkflowEnrollment.findById(enr._id).lean();
  };
  const etiquetas = async () => (await Patient.findById(patient._id).lean()).tags || [];
  const etapa = (stage) => Conversation.updateOne({ _id: conv._id }, { $set: { 'opportunities.0.stage': stage } });
  return { correr, etiquetas, etapa };
}

test('pasa a Perdido mientras espera → sale del flujo y no recibe los recordatorios de «Nuevo»', async () => {
  const { correr, etiquetas, etapa } = await escenario();
  let e = await correr();
  assert.equal(e.status, 'waiting', 'entró por «Nuevo» y espera');
  await etapa('perdido'); // la asesora la marca perdida durante la espera
  e = await correr(); // vence la espera
  assert.equal(e.status, 'done');
  assert.deepEqual(await etiquetas(), [], 'no salió ningún recordatorio');
  assert.ok(e.log.some((l) => /La condición cambió mientras esperaba \(antes «Nuevo», ahora «Si no»\)/.test(l.info)), JSON.stringify(e.log));
});

test('pasa a Agendado mientras espera → sigue por la rama «Agendado»', async () => {
  const { correr, etiquetas, etapa } = await escenario();
  await correr();
  await etapa('agendado');
  const e = await correr();
  assert.equal(e.status, 'done');
  assert.deepEqual(await etiquetas(), ['rama-agendado']);
});

test('sin cambios, la rama sigue como siempre', async () => {
  const { correr, etiquetas } = await escenario();
  await correr();
  let e = await correr();
  assert.equal(e.status, 'waiting');
  assert.deepEqual(await etiquetas(), ['recordatorio-1']);
  e = await correr();
  assert.equal(e.status, 'done');
  assert.deepEqual(await etiquetas(), ['recordatorio-1', 'recordatorio-2']);
});

test('lo que cambia el PROPIO flujo no lo saca de la rama', async () => {
  const { correr, etiquetas } = await escenario({
    pasosNuevo: [
      { id: 'mv', type: 'move_stage', position: { x: 0, y: 0 }, data: { stage: 'contactado' } },
      espera('w1'), etiqueta('m1', 'sigue'),
    ],
    aristasNuevo: [
      { id: 'e1', source: 'cond', target: 'mv', sourceHandle: 'yes' },
      { id: 'e2', source: 'mv', target: 'w1' },
      { id: 'e3', source: 'w1', target: 'm1' },
    ],
  });
  await correr();
  const e = await correr();
  assert.equal(e.status, 'done');
  assert.deepEqual(await etiquetas(), ['sigue'], 'el flujo movió la etapa él mismo: sigue en su rama');
});

test('con «volver a comprobar» apagado, el nodo decide una sola vez (como antes)', async () => {
  const { correr, etiquetas, etapa } = await escenario({ recheck: false });
  await correr();
  await etapa('perdido');
  await correr();
  assert.deepEqual(await etiquetas(), ['recordatorio-1']);
});
