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

test('pickClinicRoute: elige la ruta de la sucursal del contacto; sin match → fallback', () => {
  const routes = [
    { id: 'rq', clinicId: 'AAA', name: 'Quito' },
    { id: 'rg', clinicId: 'BBB', name: 'Guayaquil' },
    { id: 'ro', isFallback: true, name: 'Otras' },
  ];
  assert.equal(engine.pickClinicRoute(routes, 'AAA').id, 'rq');
  assert.equal(engine.pickClinicRoute(routes, 'BBB').id, 'rg');
  assert.equal(engine.pickClinicRoute(routes, 'ZZZ').id, 'ro'); // sin coincidencia → fallback
  assert.equal(engine.pickClinicRoute(routes, '').id, 'ro');
  // Sin fallback y sin match → null (termina la rama).
  assert.equal(engine.pickClinicRoute(routes.slice(0, 2), 'ZZZ'), null);
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

test('split POR SUCURSAL enruta por la sede del contacto (context.eventClinicId)', async () => {
  const main = await Clinic.create({ name: 'Call Center' });
  const quito = await Clinic.create({ name: 'Quito' });
  const gye = await Clinic.create({ name: 'Guayaquil' });
  const patient = await Patient.create({ clinic: main._id, firstName: 'Sara', lastName: 'P', phone: '0991112223' });

  const wf = await Workflow.create({
    clinic: main._id, name: 'Split sucursal', active: true,
    triggers: [{ type: 'contact_import', audience: 'all' }],
    nodes: [
      { id: 'trigger', type: 'trigger', position: { x: 0, y: 0 }, data: { triggers: [{ type: 'contact_import' }] } },
      { id: 'sp', type: 'split', position: { x: 0, y: 130 }, data: { distribution: 'clinic', routes: [
        { id: 'rq', clinicId: String(quito._id), name: 'Quito' },
        { id: 'rg', clinicId: String(gye._id), name: 'Guayaquil' },
        { id: 'ro', isFallback: true, name: 'Otras' },
      ] } },
      { id: 'tq', type: 'add_tag', position: { x: -120, y: 260 }, data: { tag: 'sede-quito' } },
      { id: 'tg', type: 'add_tag', position: { x: 0, y: 260 }, data: { tag: 'sede-gye' } },
      { id: 'to', type: 'add_tag', position: { x: 120, y: 260 }, data: { tag: 'sede-otra' } },
    ],
    edges: [
      { id: 'e0', source: 'trigger', target: 'sp', sourceHandle: 'default' },
      { id: 'eq', source: 'sp', target: 'tq', sourceHandle: 'rq' },
      { id: 'eg', source: 'sp', target: 'tg', sourceHandle: 'rg' },
      { id: 'eo', source: 'sp', target: 'to', sourceHandle: 'ro' },
    ],
  });

  const run = async (eventClinicId) => {
    const e = await WorkflowEnrollment.create({
      clinic: main._id, workflow: wf._id, patient: patient._id,
      currentNodeId: 'sp', startNodeId: 'trigger', status: 'active',
      context: { eventClinicId: String(eventClinicId) },
    });
    await engine.executeEnrollment(await WorkflowEnrollment.findById(e._id));
  };

  await run(gye._id); // el contacto está en Guayaquil → rama gye
  let tags = (await Patient.findById(patient._id).lean()).tags || [];
  assert.ok(tags.includes('sede-gye'), 'enrutó a la sede de Guayaquil');
  assert.ok(!tags.includes('sede-quito'));

  // Una sucursal que NO es ruta → fallback "Otras".
  const otra = await Clinic.create({ name: 'Cuenca' });
  await run(otra._id);
  tags = (await Patient.findById(patient._id).lean()).tags || [];
  assert.ok(tags.includes('sede-otra'), 'sin ruta para la sede → fallback');
});
