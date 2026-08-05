const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeWaitUntil, evaluateCondition, evaluateSingleCondition, evaluateConditionGroup, branchesOf, matchBranch,
  personalize, renderText, classifyReply, findStartNode, nextNodeId, triggerMatchesEvent,
} = require('../utils/workflowEngine');

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

test('triggerMatchesEvent filtra por sucursal del evento (clinicFilter)', () => {
  const tr = { type: 'appointment_created', audience: 'all', clinicFilter: 'A' };
  assert.equal(triggerMatchesEvent(tr, 'appointment_created', { clinicId: 'A' }, []), true);
  assert.equal(triggerMatchesEvent(tr, 'appointment_created', { clinicId: 'B' }, []), false);
  // Sin filtro dispara para cualquier sede.
  const any = { type: 'appointment_created', audience: 'all', clinicFilter: null };
  assert.equal(triggerMatchesEvent(any, 'appointment_created', { clinicId: 'B' }, []), true);
});

test('evaluateCondition por sucursal del evento (context.eventClinicId)', () => {
  const context = { eventClinicId: 'A' };
  assert.equal(evaluateCondition({ field: 'clinic', op: 'eq', value: 'A' }, { context }), true);
  assert.equal(evaluateCondition({ field: 'clinic', op: 'eq', value: 'B' }, { context }), false);
  assert.equal(evaluateCondition({ field: 'clinic', op: 'neq', value: 'B' }, { context }), true);
  assert.equal(evaluateCondition({ field: 'clinic', op: 'exists' }, { context }), true);
  assert.equal(evaluateCondition({ field: 'clinic', op: 'exists' }, { context: {} }), false);
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

// ─────────── Varias condiciones por rama (Y / O) y varias ramas ───────────

test('varias condiciones CONECTADAS (Y): deben cumplirse todas', () => {
  const scope = { patient: { tags: ['vip'] }, conversation: { opportunities: [{ stage: 'agendado' }] } };
  const step = {
    match: 'all',
    conditions: [
      { field: 'stage', op: 'eq', value: 'agendado' },
      { field: 'tag', op: 'eq', value: 'vip' },
    ],
  };
  assert.equal(evaluateCondition(step, scope), true);
  // Basta con que falle una para que la rama no se cumpla.
  step.conditions[1].value = 'otra';
  assert.equal(evaluateCondition(step, scope), false);
});

test('varias condiciones INDEPENDIENTES (O): basta con una', () => {
  const scope = { patient: { tags: [] }, conversation: { opportunities: [{ stage: 'ganado' }] } };
  const step = {
    match: 'any',
    conditions: [
      { field: 'stage', op: 'eq', value: 'ganado' },
      { field: 'tag', op: 'eq', value: 'vip' },
    ],
  };
  assert.equal(evaluateCondition(step, scope), true);
  step.conditions[0].value = 'perdido';
  assert.equal(evaluateCondition(step, scope), false);
});

test('condición sin `conditions` sigue leyendo el formato legacy field/op/value', () => {
  const scope = { patient: { tags: ['vip'] } };
  assert.equal(evaluateCondition({ field: 'tag', op: 'eq', value: 'vip' }, scope), true);
  assert.equal(evaluateCondition({ conditions: [] , field: 'tag', op: 'eq', value: 'x' }, scope), false);
  // Un paso sin condiciones se cumple siempre (igual que antes con field vacío).
  assert.equal(evaluateConditionGroup({ conditions: [] }, scope), true);
});

test('operadores "es alguno de" / "no es ninguno de" (etapas del embudo)', () => {
  const scope = { conversation: { opportunities: [{ stage: 'interesado' }] } };
  assert.equal(evaluateSingleCondition({ field: 'stage', op: 'in', values: ['interesado', 'agendado'] }, scope), true);
  assert.equal(evaluateSingleCondition({ field: 'stage', op: 'in', values: ['ganado'] }, scope), false);
  assert.equal(evaluateSingleCondition({ field: 'stage', op: 'nin', values: ['ganado', 'perdido'] }, scope), true);
  // Sin `values`, acepta la lista separada por comas.
  assert.equal(evaluateSingleCondition({ field: 'stage', op: 'in', value: 'ganado, interesado' }, scope), true);
});

test('la etapa sale de opportunities[] (canónico), del espejo legacy o del contexto', () => {
  const c = { field: 'stage', op: 'eq', value: 'ganado' };
  // Canónico: la ÚLTIMA del array manda sobre el espejo legacy.
  assert.equal(evaluateSingleCondition(c, { conversation: { opportunity: { stage: 'nuevo' }, opportunities: [{ stage: 'contactado' }, { stage: 'ganado' }] } }), true);
  assert.equal(evaluateSingleCondition(c, { conversation: { opportunity: { stage: 'ganado' } } }), true);
  // Sin conversación cargada, la etapa del evento que inscribió el flujo.
  assert.equal(evaluateSingleCondition(c, { context: { stage: 'ganado' } }), true);
});

test('condiciones de etiquetas del chat, de la oportunidad y valor esperado', () => {
  const conversation = { tags: ['seguimiento'], opportunities: [{ stage: 'agendado', tags: ['botox'], expectedValue: 800 }] };
  assert.equal(evaluateSingleCondition({ field: 'chatTag', op: 'eq', value: 'seguimiento' }, { conversation }), true);
  assert.equal(evaluateSingleCondition({ field: 'opportunityTag', op: 'in', values: ['botox', 'laser'] }, { conversation }), true);
  assert.equal(evaluateSingleCondition({ field: 'opportunityValue', op: 'gt', value: '500' }, { conversation }), true);
  assert.equal(evaluateSingleCondition({ field: 'opportunityValue', op: 'lt', value: '500' }, { conversation }), false);
});

test('matchBranch devuelve la PRIMERA rama que se cumple (if / else-if)', () => {
  const step = {
    branches: [
      { id: 'yes', name: 'Ganado', match: 'all', conditions: [{ field: 'stage', op: 'eq', value: 'ganado' }] },
      { id: 'b2', name: 'Agendado', match: 'all', conditions: [{ field: 'stage', op: 'eq', value: 'agendado' }] },
    ],
  };
  assert.equal(matchBranch(step, { conversation: { opportunities: [{ stage: 'agendado' }] } }).id, 'b2');
  assert.equal(matchBranch(step, { conversation: { opportunities: [{ stage: 'ganado' }] } }).id, 'yes');
  // Ninguna se cumple → null (el motor sale por la rama 'no').
  assert.equal(matchBranch(step, { conversation: { opportunities: [{ stage: 'perdido' }] } }), null);
});

test('un nodo sin `branches` se comporta como la condición clásica (handle yes)', () => {
  const legacy = { field: 'tag', op: 'eq', value: 'vip' };
  assert.equal(branchesOf(legacy).length, 1);
  assert.equal(branchesOf(legacy)[0].id, 'yes');
  assert.equal(matchBranch(legacy, { patient: { tags: ['vip'] } }).id, 'yes');
  assert.equal(matchBranch(legacy, { patient: { tags: [] } }), null);
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
