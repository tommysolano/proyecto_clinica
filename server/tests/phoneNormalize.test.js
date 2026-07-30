/**
 * Normalización de teléfonos del importador de contactos. Es la base de la
 * deduplicación y del envío: si un mismo número no cae SIEMPRE en la misma
 * cadena, se duplican contactos y los mensajes no salen.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizePhone,
  isEcuadorMobile,
  formatPhone,
  phoneSearchRegex,
  phoneMatchesSearch,
} = require('../utils/phoneNormalize');

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

// ---------- Búsqueda por teléfono (buscador de chats/oportunidades) ----------

test('el buscador encuentra el número guardado escrito como se quiera', () => {
  const guardado = '593988535561'; // como lo guarda WhatsApp
  const encuentra = (escrito) =>
    assert.equal(phoneMatchesSearch(escrito, guardado), true, `"${escrito}" debería encontrarlo`);

  encuentra('0988535561');        // local con 0 (el caso del reclamo)
  encuentra('098 853 5561');      // local con espacios
  encuentra('098-853-5561');      // local con guiones
  encuentra('988535561');         // sin 0 ni país
  encuentra('593988535561');      // tal cual está guardado
  encuentra('+593 98 853 5561');  // internacional con espacios
  encuentra('00593988535561');    // prefijo internacional 00
  encuentra('8535561');           // un trozo del final
  encuentra('  0988535561  ');    // pegado con espacios alrededor
});

test('el buscador NO confunde números distintos', () => {
  assert.equal(phoneMatchesSearch('0988535561', '593999111222'), false);
  // Un dígito de diferencia en el medio.
  assert.equal(phoneMatchesSearch('0988535561', '593988535562'), false);
});

test('funciona con números de otros países, no solo Ecuador', () => {
  // Colombia: guardado 573113380263.
  assert.equal(phoneMatchesSearch('3113380263', '573113380263'), true);   // local
  assert.equal(phoneMatchesSearch('+57 311 3380263', '573113380263'), true);
  assert.equal(phoneMatchesSearch('03113380263', '573113380263'), true);  // con 0 de marcación
  // España (fijo/móvil de 9 dígitos) y EE.UU.
  assert.equal(phoneMatchesSearch('612345678', '34612345678'), true);
  assert.equal(phoneMatchesSearch('(305) 555-0199', '13055550199'), true);
});

test('el número guardado con separadores también se encuentra', () => {
  // Conversaciones/contactos antiguos que quedaron con '+' o espacios.
  assert.equal(phoneMatchesSearch('0988535561', '+593 98 853 5561'), true);
});

test('un texto que no es teléfono no se busca como teléfono', () => {
  assert.equal(phoneSearchRegex('Ana'), null);
  assert.equal(phoneSearchRegex(''), null);
  assert.equal(phoneSearchRegex(null), null);
  assert.equal(phoneSearchRegex('123'), null); // 3 dígitos: casaría con media base
  assert.equal(phoneMatchesSearch('Ana', '593988535561'), false);
});

test('acepta varios teléfonos del mismo contacto', () => {
  assert.equal(phoneMatchesSearch('0988535561', [null, '593999111222', '593988535561']), true);
  assert.equal(phoneMatchesSearch('0988535561', [null, undefined, '']), false);
});
