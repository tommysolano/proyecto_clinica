const test = require('node:test');
const assert = require('node:assert/strict');
const {
  templateKeys,
  resolveContactVar,
  guessSource,
  suggestVarMapping,
  buildContactTemplateVars,
} = require('../utils/contactTemplateVars');

const tplNombre = { body: 'Hola {{nombre}}, te esperamos.', variables: [{ key: 'nombre', example: 'María' }] };

test('templateKeys: en orden de aparición y sin repetir', () => {
  const tpl = { body: 'Hola {{nombre}}, tu cita {{fecha}} — nos vemos {{fecha}}, {{nombre}}.' };
  assert.deepEqual(templateKeys(tpl), ['nombre', 'fecha']);
});

test('templateKeys: plantilla sin variables', () => {
  assert.deepEqual(templateKeys({ body: 'Promo de julio, escríbenos.' }), []);
  assert.deepEqual(templateKeys(null), []);
});

test('templateKeys: tolera espacios dentro de las llaves', () => {
  assert.deepEqual(templateKeys({ body: 'Hola {{ nombre }} y {{  apellido  }}' }), ['nombre', 'apellido']);
});

test('resolveContactVar: saca el nombre del contacto importado', () => {
  const c = { firstName: 'Emily', lastName: 'Torres', phone: '593999111222' };
  assert.equal(resolveContactVar('nombre', c), 'Emily');
  assert.equal(resolveContactVar('apellido', c), 'Torres');
  assert.equal(resolveContactVar('nombre_completo', c), 'Emily Torres');
  assert.equal(resolveContactVar('telefono', c), '593999111222');
});

test('resolveContactVar: si solo hay displayName, el nombre sale de ahí', () => {
  // Caso real del Excel de WhatsApp: la gente se guarda como "Emily 🍓" o "Dome".
  const c = { displayName: 'Emily 🍓' };
  assert.equal(resolveContactVar('nombre', c), 'Emily');
  assert.equal(resolveContactVar('nombre_completo', c), 'Emily 🍓');
});

test('resolveContactVar: texto fijo, igual para todos', () => {
  assert.equal(resolveContactVar('fixed', { firstName: 'Ana' }, 'JULIO20'), 'JULIO20');
});

test('resolveContactVar: campo personalizado, venga como Map o como objeto', () => {
  const asMap = { customFields: new Map([['ciudad', 'Quito']]) };
  const asObj = { customFields: { ciudad: 'Guayaquil' } };
  assert.equal(resolveContactVar('custom:ciudad', asMap), 'Quito');
  assert.equal(resolveContactVar('custom:ciudad', asObj), 'Guayaquil');
  assert.equal(resolveContactVar('custom:noexiste', asMap), '');
});

test('guessSource: reconoce los nombres evidentes y admite {{1}}', () => {
  assert.equal(guessSource('nombre'), 'nombre');
  assert.equal(guessSource('firstName'), 'nombre');
  assert.equal(guessSource('1'), 'nombre');
  assert.equal(guessSource('apellidos'), 'apellido');
  assert.equal(guessSource('telefono'), 'telefono');
  // Lo que el sistema NO puede saber se deja sin fuente: lo decide el usuario.
  assert.equal(guessSource('codigo_promo'), '');
});

test('suggestVarMapping: propone lo evidente y deja lo demás en blanco', () => {
  const tpl = { body: 'Hola {{nombre}}, usa {{codigo_promo}}' };
  assert.deepEqual(suggestVarMapping(tpl), [
    { key: 'nombre', source: 'nombre', fixed: '' },
    { key: 'codigo_promo', source: '', fixed: '' },
  ]);
});

test('buildContactTemplateVars: rellena con el contacto, NO con el ejemplo de la plantilla', () => {
  // Este es el bug que arregla el módulo: sin él, messaging no encontraba paciente
  // y caía al ejemplo, mandando "Hola María" a los 800 contactos de la campaña.
  const vars = buildContactTemplateVars(tplNombre, { firstName: 'Emily' }, [{ key: 'nombre', source: 'nombre' }]);
  assert.deepEqual(vars, ['Emily']);
  assert.notEqual(vars[0], 'María');
});

test('buildContactTemplateVars: respeta el orden de las claves de la plantilla', () => {
  // El orden es lo que hace que cuadre con lo que Meta espera (si no: #132000).
  const tpl = { body: '{{apellido}} {{nombre}}' };
  const mapping = [{ key: 'nombre', source: 'nombre' }, { key: 'apellido', source: 'apellido' }];
  assert.deepEqual(buildContactTemplateVars(tpl, { firstName: 'Emily', lastName: 'Torres' }, mapping), [
    'Torres',
    'Emily',
  ]);
});

test('buildContactTemplateVars: nunca devuelve vacío, porque Meta lo rechaza', () => {
  const vars = buildContactTemplateVars(tplNombre, { phone: '593999111222' }, [{ key: 'nombre', source: 'nombre' }]);
  assert.deepEqual(vars, ['-']);
});

test('buildContactTemplateVars: sin mapeo, cae en la propuesta por nombre', () => {
  assert.deepEqual(buildContactTemplateVars(tplNombre, { firstName: 'Emily' }, []), ['Emily']);
});

test('buildContactTemplateVars: plantilla sin variables no manda parámetros', () => {
  // Mandar parámetros a una plantilla sin variables es el error #132000 de Meta.
  assert.deepEqual(buildContactTemplateVars({ body: 'Promo de julio' }, { firstName: 'Emily' }, []), []);
});

test('buildContactTemplateVars: mezcla datos del contacto con un texto fijo', () => {
  const tpl = { body: 'Hola {{nombre}}, usa el código {{promo}}' };
  const mapping = [
    { key: 'nombre', source: 'nombre' },
    { key: 'promo', source: 'fixed', fixed: 'JULIO20' },
  ];
  assert.deepEqual(buildContactTemplateVars(tpl, { firstName: 'Emily' }, mapping), ['Emily', 'JULIO20']);
});
