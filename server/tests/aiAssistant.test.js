const test = require('node:test');
const assert = require('node:assert/strict');
const { buildUserPrompt, extractText } = require('../utils/aiAssistant');

test('buildUserPrompt renders an in/out transcript with roles', () => {
  const prompt = buildUserPrompt(
    [
      { direction: 'in', body: 'Hola, ¿tienen cita mañana?' },
      { direction: 'out', body: '¡Claro! ¿A qué hora te conviene?' },
      { direction: 'in', body: 'En la tarde' },
    ],
    'María'
  );
  assert.match(prompt, /Paciente: Hola, ¿tienen cita mañana\?/);
  assert.match(prompt, /Agente: ¡Claro!/);
  assert.match(prompt, /El paciente se llama María\./);
});

test('buildUserPrompt skips empty bodies and omits name when absent', () => {
  const prompt = buildUserPrompt([{ direction: 'in', body: '' }, { direction: 'in', body: 'Hola' }], '');
  assert.match(prompt, /Paciente: Hola/);
  assert.doesNotMatch(prompt, /se llama/);
});

test('extractText concatenates only text blocks from the API response', () => {
  const data = {
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'Hola, ' },
      { type: 'text', text: 'con gusto te ayudo.' },
    ],
  };
  assert.equal(extractText(data), 'Hola, con gusto te ayudo.');
});

test('extractText returns empty string when there is no content', () => {
  assert.equal(extractText({}), '');
  assert.equal(extractText({ content: [{ type: 'thinking', thinking: 'x' }] }), '');
});
