const test = require('node:test');
const assert = require('node:assert/strict');
const { computeWaitUntil, evaluateCondition, personalize } = require('../utils/workflowEngine');

test('computeWaitUntil applies a negative offset (e.g. 24h before the appointment)', () => {
  const ctx = { appointmentDate: '2026-06-20T15:00:00Z' };
  const target = computeWaitUntil({ waitEvent: 'appointment_date', offsetMinutes: -24 * 60 }, ctx);
  assert.equal(target.toISOString(), '2026-06-19T15:00:00.000Z');
});

test('computeWaitUntil returns null without a base date', () => {
  assert.equal(computeWaitUntil({ waitEvent: 'appointment_date', offsetMinutes: -60 }, {}), null);
  assert.equal(computeWaitUntil({ waitEvent: '', offsetMinutes: 0 }, { appointmentDate: new Date() }), null);
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
