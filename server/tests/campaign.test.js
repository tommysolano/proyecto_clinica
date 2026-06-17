const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('../controllers/campaignController');

const { personalize, buildVars, firstNameOf } = _internal;

test('firstNameOf prefers firstName, falls back to first token of name', () => {
  assert.equal(firstNameOf({ firstName: 'Ana', name: 'Ana Pérez' }), 'Ana');
  assert.equal(firstNameOf({ name: 'Juan Carlos Soto' }), 'Juan');
  assert.equal(firstNameOf({}), '');
});

test('personalize replaces nombre/name/firstName tokens with the first name', () => {
  const p = { name: 'María López' };
  assert.equal(personalize('Hola {{nombre}}, ¿cómo estás?', p), 'Hola María, ¿cómo estás?');
  assert.equal(personalize('Hi {{firstName}}', p), 'Hi María');
  assert.equal(personalize('Sin variables', p), 'Sin variables');
});

test('buildVars maps template variables to patient fields', () => {
  const template = { variables: [{ key: 'firstName' }, { key: 'lastName' }, { key: 'fecha', example: '17/06' }] };
  const vars = buildVars(template, { name: 'Pedro Páez' });
  assert.deepEqual(vars, ['Pedro', 'Páez', '17/06']);
});

test('buildVars returns empty array when the template has no variables', () => {
  assert.deepEqual(buildVars({ variables: [] }, { name: 'X' }), []);
  assert.deepEqual(buildVars(null, { name: 'X' }), []);
});
