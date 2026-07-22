/**
 * Nodo Dividir (split / bifurcación), estilo Daplox/GoHighLevel: reparte al
 * contacto por UNA de varias rutas según el % de cada una (Random Split, A/B).
 * Cada ruta es una salida con su propio sourceHandle = route.id.
 *
 * - pickSplitRoute (PURO): selección ponderada por %, uniforme si todos 0, null si vacío.
 * - executeGraphEnrollment: sigue la arista de la ruta elegida (100/0 ⇒ determinista).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const H = require('./_integrationHelpers');
const engine = require('../utils/workflowEngine');

const Clinic = require('../models/Clinic');
const Patient = require('../models/Patient');
const Workflow = require('../models/Workflow');
const WorkflowEnrollment = require('../models/WorkflowEnrollment');

// ─────────── Unidad: pickSplitRoute ───────────
test('pickSplitRoute reparte ponderado por porcentaje (rand inyectable)', () => {
  const routes = [
    { id: 'ra', name: 'A', percent: 30 },
    { id: 'rb', name: 'B', percent: 70 },
  ];
  // total = 100. roll = rand*100. rand=0 → cae en A (primeros 30). rand=0.5 → 50 > 30 → B.
  assert.equal(engine.pickSplitRoute(routes, () => 0).id, 'ra');
  assert.equal(engine.pickSplitRoute(routes, () => 0.29).id, 'ra');
  assert.equal(engine.pickSplitRoute(routes, () => 0.31).id, 'rb');
  assert.equal(engine.pickSplitRoute(routes, () => 0.999).id, 'rb');
});

test('pickSplitRoute: sin porcentajes válidos → reparto uniforme; sin rutas → null', () => {
  const routes = [{ id: 'ra', percent: 0 }, { id: 'rb', percent: 0 }, { id: 'rc', percent: 0 }];
  assert.equal(engine.pickSplitRoute(routes, () => 0).id, 'ra');
  assert.equal(engine.pickSplitRoute(routes, () => 0.34).id, 'rb');
  assert.equal(engine.pickSplitRoute(routes, () => 0.67).id, 'rc');
  assert.equal(engine.pickSplitRoute([], () => 0), null);
  assert.equal(engine.pickSplitRoute(undefined, () => 0), null);
});

test('pickSplitRoute respeta pesos relativos aunque no sumen 100', () => {
  const routes = [{ id: 'ra', percent: 10 }, { id: 'rb', percent: 30 }]; // total 40
  assert.equal(engine.pickSplitRoute(routes, () => 0.2).id, 'ra'); // 0.2*40=8 < 10
  assert.equal(engine.pickSplitRoute(routes, () => 0.3).id, 'rb'); // 0.3*40=12 > 10
});

// ─────────── Integración: el motor sigue la ruta elegida ───────────
test.before(async () => { await H.startDb(); });
test.after(async () => { await H.stopDb(); });
test.beforeEach(async () => { await H.resetDb(); });

async function splitWorkflow(clinicId, percents) {
  return Workflow.create({
    clinic: clinicId, name: 'Split test', active: true,
    triggers: [{ type: 'appointment_created', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'appointment_created' }] } },
      { id: 'sp', type: 'split', position: { x: 0, y: 130 }, data: { distribution: 'random', routes: [{ id: 'ra', name: 'A', percent: percents[0] }, { id: 'rb', name: 'B', percent: percents[1] }] } },
      { id: 'ta', type: 'add_tag', position: { x: -120, y: 260 }, data: { tag: 'rama-A' } },
      { id: 'tb', type: 'add_tag', position: { x: 120, y: 260 }, data: { tag: 'rama-B' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'sp', sourceHandle: 'default' },
      { id: 'ea', source: 'sp', target: 'ta', sourceHandle: 'ra' },
      { id: 'eb', source: 'sp', target: 'tb', sourceHandle: 'rb' },
    ],
  });
}

async function runFrom(wf, clinicId, patientId) {
  const enr = await WorkflowEnrollment.create({
    clinic: clinicId, workflow: wf._id, patient: patientId,
    currentNodeId: 'sp', startNodeId: 'trigger', status: 'active', context: {},
  });
  await engine.executeEnrollment(await WorkflowEnrollment.findById(enr._id));
  return WorkflowEnrollment.findById(enr._id);
}

test('split 100/0 lleva SIEMPRE por la ruta A (aplica su etiqueta)', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Ana', lastName: 'V', phone: '0991234567' });
  const wf = await splitWorkflow(clinic._id, [100, 0]);

  const enr = await runFrom(wf, clinic._id, patient._id);
  assert.equal(enr.status, 'done');
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok((fresh.tags || []).includes('rama-A'), 'tomó la ruta A (100%)');
  assert.ok(!(fresh.tags || []).includes('rama-B'), 'NO tomó la ruta B (0%)');
  // El registro deja constancia de la ruta elegida.
  assert.ok((enr.log || []).some((l) => l.type === 'split' && /Ruta «A»/.test(l.info)));
});

test('split 0/100 lleva SIEMPRE por la ruta B', async () => {
  const clinic = await Clinic.create({ name: 'Principal' });
  const patient = await Patient.create({ clinic: clinic._id, firstName: 'Leo', lastName: 'M', phone: '0990000000' });
  const wf = await splitWorkflow(clinic._id, [0, 100]);

  const enr = await runFrom(wf, clinic._id, patient._id);
  assert.equal(enr.status, 'done');
  const fresh = await Patient.findById(patient._id).lean();
  assert.ok((fresh.tags || []).includes('rama-B'), 'tomó la ruta B (100%)');
  assert.ok(!(fresh.tags || []).includes('rama-A'));
});
