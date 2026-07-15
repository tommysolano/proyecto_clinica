const test = require('node:test');
const assert = require('node:assert/strict');
const { computeWaitUntil, evaluateCondition, personalize, renderText, classifyReply, findStartNode, nextNodeId } = require('../utils/workflowEngine');

test('computeWaitUntil applies a negative offset (e.g. 24h before the appointment)', () => {
  const ctx = { appointmentDate: '2026-06-20T15:00:00Z' };
  const target = computeWaitUntil({ waitEvent: 'appointment_date', offsetMinutes: -24 * 60 }, ctx);
  assert.equal(target.toISOString(), '2026-06-19T15:00:00.000Z');
});

test('computeWaitUntil returns null without a base date', () => {
  assert.equal(computeWaitUntil({ waitEvent: 'appointment_date', offsetMinutes: -60 }, {}), null);
  assert.equal(computeWaitUntil({ waitEvent: '', offsetMinutes: 0 }, { appointmentDate: new Date() }), null);
});

test('computeWaitUntil modo hora fija: N días antes de la cita a las HH:MM (hora local)', () => {
  // Cita el 20 de junio (guardada a mediodía local); recordatorio 1 día antes a las 18:00.
  const ctx = { appointmentDate: new Date(2026, 5, 20, 12, 0, 0) };
  const target = computeWaitUntil(
    { waitEvent: 'appointment_date', waitMode: 'clock', daysBefore: 1, atTime: '18:00' },
    ctx
  );
  assert.equal(target.getFullYear(), 2026);
  assert.equal(target.getMonth(), 5);
  assert.equal(target.getDate(), 19); // día anterior
  assert.equal(target.getHours(), 18);
  assert.equal(target.getMinutes(), 0);

  // Mismo día de la cita a las 08:30, sin importar la hora de la cita.
  const sameDay = computeWaitUntil(
    { waitEvent: 'appointment_date', waitMode: 'clock', daysBefore: 0, atTime: '08:30' },
    ctx
  );
  assert.equal(sameDay.getDate(), 20);
  assert.equal(sameDay.getHours(), 8);
  assert.equal(sameDay.getMinutes(), 30);

  // Hora inválida → null (el runner continúa sin esperar en vez de romperse).
  assert.equal(
    computeWaitUntil({ waitEvent: 'appointment_date', waitMode: 'clock', daysBefore: 1, atTime: 'x' }, ctx),
    null
  );
});

test('evaluateCondition checks tags', () => {
  const patient = { tags: ['ortodoncia', 'vip'] };
  assert.equal(evaluateCondition({ field: 'tag', op: 'eq', value: 'vip' }, { patient }), true);
  assert.equal(evaluateCondition({ field: 'tag', op: 'eq', value: 'x' }, { patient }), false);
  assert.equal(evaluateCondition({ field: 'tag', op: 'neq', value: 'x' }, { patient }), true);
  assert.equal(evaluateCondition({ field: 'tag', op: 'exists' }, { patient }), true);
  assert.equal(evaluateCondition({ field: 'tag', op: 'exists' }, { patient: { tags: [] } }), false);
});

test('evaluateCondition checks opportunity stage and source', () => {
  const conversation = { opportunity: { stage: 'agendado' } };
  assert.equal(evaluateCondition({ field: 'stage', op: 'eq', value: 'agendado' }, { conversation }), true);
  assert.equal(evaluateCondition({ field: 'stage', op: 'neq', value: 'ganado' }, { conversation }), true);
  assert.equal(evaluateCondition({ field: 'source', op: 'eq', value: 'anuncio' }, { patient: { source: 'anuncio' } }), true);
});

test('evaluateCondition hasPatient + unknown field defaults to true', () => {
  assert.equal(evaluateCondition({ field: 'hasPatient' }, { patient: { _id: 1 } }), true);
  assert.equal(evaluateCondition({ field: 'hasPatient' }, {}), false);
  assert.equal(evaluateCondition({ field: '' }, {}), true);
});

test('personalize replaces name tokens', () => {
  assert.equal(personalize('Hola {{nombre}}', { firstName: 'Ana' }), 'Hola Ana');
});

test('renderText resuelve el catálogo completo de variables del paciente (igual que las plantillas)', async () => {
  const patient = { firstName: 'Ana', lastName: 'Vera' };
  assert.equal(await renderText('Hola {{nombre}} {{apellido}}', patient), 'Hola Ana Vera');
  assert.equal(await renderText('{{nombre_completo}}', patient), 'Ana Vera');
  // Variable desconocida o sin dato: se elimina (al paciente no le llega "{{x}}").
  assert.equal(await renderText('x {{desconocida}} y', patient), 'x y');
  // Sin cita en el contexto, las variables de cita quedan vacías sin romper.
  assert.equal((await renderText('Cita: {{fecha_cita}} {{hora_cita}}', patient)).trim(), 'Cita:');
  // Texto sin variables pasa intacto (sin tocar espacios ni saltos).
  assert.equal(await renderText('sin  variables', patient), 'sin  variables');
});

test('classifyReply detects affirmative, negative and other', () => {
  assert.equal(classifyReply('Sí'), 'yes');
  assert.equal(classifyReply('si confirmo'), 'yes');
  assert.equal(classifyReply('OK'), 'yes');
  assert.equal(classifyReply('No'), 'no');
  assert.equal(classifyReply('no puedo asistir'), 'no');
  assert.equal(classifyReply('cancelar'), 'no');
  assert.equal(classifyReply('¿a qué hora era?'), 'other');
  assert.equal(classifyReply(''), 'other');
});

test('evaluateCondition reads lastReply from context', () => {
  assert.equal(evaluateCondition({ field: 'lastReply', op: 'eq', value: 'yes' }, { context: { lastReply: 'yes' } }), true);
  assert.equal(evaluateCondition({ field: 'lastReply', op: 'eq', value: 'no' }, { context: { lastReply: 'yes' } }), false);
  assert.equal(evaluateCondition({ field: 'lastReply', op: 'exists' }, { context: { lastReply: 'other' } }), false);
  assert.equal(evaluateCondition({ field: 'lastReply', op: 'exists' }, { context: { lastReply: 'no' } }), true);
});

// ─────────── Grafo (nodes/edges) ───────────
const graph = {
  nodes: [
    { id: 'trigger', type: 'trigger' },
    { id: 'a', type: 'send_message' },
    { id: 'cond', type: 'condition' },
    { id: 'yes', type: 'send_message' },
    { id: 'no', type: 'send_message' },
  ],
  edges: [
    { id: 'e1', source: 'trigger', target: 'a', sourceHandle: 'default' },
    { id: 'e2', source: 'a', target: 'cond', sourceHandle: 'default' },
    { id: 'e3', source: 'cond', target: 'yes', sourceHandle: 'yes' },
    { id: 'e4', source: 'cond', target: 'no', sourceHandle: 'no' },
  ],
};

test('findStartNode returns the trigger node', () => {
  assert.equal(findStartNode(graph).id, 'trigger');
});

test('findStartNode falls back to the node with no incoming edges', () => {
  const g = { nodes: [{ id: 'x', type: 'send_message' }, { id: 'y', type: 'wait' }], edges: [{ source: 'x', target: 'y', sourceHandle: 'default' }] };
  assert.equal(findStartNode(g).id, 'x');
});

test('nextNodeId follows default and yes/no branches', () => {
  assert.equal(nextNodeId(graph, 'trigger'), 'a');
  assert.equal(nextNodeId(graph, 'a'), 'cond');
  assert.equal(nextNodeId(graph, 'cond', 'yes'), 'yes');
  assert.equal(nextNodeId(graph, 'cond', 'no'), 'no');
});

test('nextNodeId returns null at a leaf node', () => {
  assert.equal(nextNodeId(graph, 'yes'), null);
});
