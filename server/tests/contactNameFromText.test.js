/**
 * El nombre que el propio contacto escribe en el chat.
 *
 * La bandeja se veía llena de "Yo…!!!", emojis y números pelados —el nombre del
 * PERFIL de WhatsApp— aunque la persona hubiera dicho cómo se llama en el primer
 * mensaje. Esto lee ese nombre del texto.
 *
 * Lo que de verdad prueba este archivo son los FALSOS POSITIVOS: renombrar el chat
 * de alguien con una frase suelta ("soy de Portoviejo") es peor que no renombrarlo,
 * porque el asesor se dirige a la persona por un nombre que no es el suyo. Ante la
 * duda, la función devuelve ''.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { contactNameFromText } = require('../utils/contactNameFromText');

test('fórmulas explícitas: se queda con el nombre y lo capitaliza', () => {
  assert.equal(contactNameFromText('Hola, me llamo Ana Pérez'), 'Ana Pérez');
  assert.equal(contactNameFromText('mi nombre es JUAN CARLOS MOREIRA VERA'), 'Juan Carlos Moreira Vera');
  assert.equal(contactNameFromText('Nombre: maría josé zambrano'), 'María José Zambrano');
  assert.equal(contactNameFromText('buenas, me llamo reina'), 'Reina');
});

test('"soy X" solo cuando TODO lo que sigue parece un nombre', () => {
  assert.equal(contactNameFromText('Soy Ana Pérez'), 'Ana Pérez');
  // Las tres formas en que "soy" no habla de un nombre.
  assert.equal(contactNameFromText('Soy de Portoviejo'), '');
  assert.equal(contactNameFromText('soy paciente de la clinica'), '');
  assert.equal(contactNameFromText('soy la señora que llamó ayer'), '');
});

test('un mensaje que es SOLO un nombre se acepta únicamente si el chat no tiene ninguno', () => {
  // Respuesta típica a "¿cuál es tu nombre?".
  assert.equal(contactNameFromText('Ana Pérez', { allowBare: true }), 'Ana Pérez');
  // Con el chat ya nombrado no se arriesga.
  assert.equal(contactNameFromText('Ana Pérez'), '');
  // Y nunca una sola palabra: "Emily" podría ser cualquier cosa.
  assert.equal(contactNameFromText('Emily', { allowBare: true }), '');
});

test('el ruido normal de un chat NO renombra a nadie', () => {
  const ruido = [
    'Buenos días',
    'gracias',
    'Vi en tik tok que realizan ecografias',
    'quiero información de precios',
    '10 🍏🌎',
    'Hola estimad@ una consulta por favor',
    '¿Cuánto cuesta la consulta?',
    'ok listo',
    '',
    '   ',
  ];
  for (const t of ruido) {
    assert.equal(contactNameFromText(t, { allowBare: true }), '', `no debería detectar nombre en: ${t}`);
  }
});

test('un texto larguísimo se ignora entero (no es alguien diciendo su nombre)', () => {
  assert.equal(contactNameFromText(`me llamo Ana ${'x'.repeat(400)}`), '');
});
