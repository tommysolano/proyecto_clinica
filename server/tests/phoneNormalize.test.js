/**
 * Normalización de teléfonos del importador de contactos. Es la base de la
 * deduplicación y del envío: si un mismo número no cae SIEMPRE en la misma
 * cadena, se duplican contactos y los mensajes no salen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizePhone, isEcuadorMobile, formatPhone } = require('../utils/phoneNormalize');

const ok = (raw) => {
  const r = normalizePhone(raw);
  assert.equal(r.ok, true, `"${raw}" debería ser válido pero: ${r.reason}`);
  return r.phone;
};

test('móvil ecuatoriano: todas las formas caen en el mismo E.164', () => {
  const esperado = '593999111222';
  // Lo que de verdad aparece en un Excel de contactos.
  assert.equal(ok('0999111222'), esperado);       // local con 0
  assert.equal(ok('099 911 1222'), esperado);     // con espacios
  assert.equal(ok('099-911-1222'), esperado);     // con guiones
  assert.equal(ok('+593999111222'), esperado);    // internacional
  assert.equal(ok('+593 99 911 1222'), esperado); // internacional con espacios
  assert.equal(ok('593999111222'), esperado);     // ya normalizado
  assert.equal(ok('999111222'), esperado);        // sin 0 ni país
  assert.equal(ok('00593999111222'), esperado);   // prefijo 00
  assert.equal(ok('  0999111222  '), esperado);   // con espacios alrededor
});

test('fijo ecuatoriano (Guayaquil)', () => {
  assert.equal(ok('042345678'), '59342345678');
  assert.equal(ok('+59342345678'), '59342345678');
});

test('números del extranjero: se respeta su indicativo', () => {
  // El de la captura de Daplox (Colombia).
  assert.equal(ok('+57 311 3380263'), '573113380263');
  assert.equal(ok('+1 305 555 0199'), '13055550199');
  assert.equal(ok('0057 311 3380263'), '573113380263');
});

test('un fijo local que empieza por 593 no se confunde con el indicativo', () => {
  // '5932345678' son 10 dígitos: si se tomara '593' como país quedaría un NSN de
  // 7 dígitos, que no es válido. Es un local → 0593... no existe, se trata como NSN.
  const r = normalizePhone('5932345678');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Ecuador/);
});

test('rechaza lo que no se puede salvar, explicando por qué', () => {
  assert.equal(normalizePhone('').ok, false);
  assert.equal(normalizePhone(null).ok, false);
  assert.equal(normalizePhone('   ').ok, false);
  assert.equal(normalizePhone('sin teléfono').ok, false);
  assert.equal(normalizePhone('12345').ok, false); // demasiado corto

  // Excel convierte los números largos a notación científica y se pierde el
  // número: hay que avisar, no guardar basura.
  const sci = normalizePhone('5.93999E+11');
  assert.equal(sci.ok, false);
  assert.match(sci.reason, /notación científica/);

  // Un internacional absurdamente largo tampoco pasa.
  assert.equal(normalizePhone('+1234567890123456789').ok, false);
});

test('el motivo del rechazo es útil para el informe de errores', () => {
  const r = normalizePhone('123456');
  assert.equal(r.ok, false);
  assert.match(r.reason, /\+indicativo/); // le dice al usuario qué hacer
});

test('isEcuadorMobile distingue móvil de fijo', () => {
  assert.equal(isEcuadorMobile('593999111222'), true);
  assert.equal(isEcuadorMobile('59342345678'), false); // fijo
  assert.equal(isEcuadorMobile('573113380263'), false); // Colombia
});

test('formatPhone deja el móvil legible', () => {
  assert.equal(formatPhone('593999111222'), '+593 99 911 1222');
  assert.equal(formatPhone('573113380263'), '+573113380263');
  assert.equal(formatPhone(''), '');
});
