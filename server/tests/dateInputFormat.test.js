/**
 * Formato de fecha dd/mm/aaaa de los formularios (client/src/utils/date.js).
 *
 * Vive aquí, en la suite del servidor, porque el cliente no tiene corredor de
 * tests y estas son funciones PURAS. Es la pieza que sostiene el componente
 * DateInput, que reemplazó a <input type="date"> en toda la app: el input
 * nativo se pinta con el formato del NAVEGADOR (mm/dd/aaaa en un Windows en
 * inglés), así que ahora la fecha se escribe y se lee aquí. Si este parseo
 * falla, se guardan fechas equivocadas en silencio.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'utils', 'date.js')
).href;

let fmtDate;
let parseDdMmYyyy;
let maskDdMmYyyy;
test.before(async () => {
  ({ fmtDate, parseDdMmYyyy, maskDdMmYyyy } = await import(MODULE));
});

test('fmtDate muestra dd/mm/aaaa desde ISO, sin correrse de día', () => {
  assert.equal(fmtDate('2026-08-11'), '11/08/2026');
  assert.equal(fmtDate('2026-08-11T00:00:00.000Z'), '11/08/2026');
  assert.equal(fmtDate('2026-01-01'), '01/01/2026');
  assert.equal(fmtDate(''), '');
  assert.equal(fmtDate(null), '');
});

test('parseDdMmYyyy lee dd/mm/aaaa y rechaza lo que no es una fecha real', () => {
  assert.equal(parseDdMmYyyy('11/08/2026'), '2026-08-11');
  assert.equal(parseDdMmYyyy('01/01/2000'), '2000-01-01');
  assert.equal(parseDdMmYyyy('29/02/2024'), '2024-02-29'); // bisiesto
  assert.equal(parseDdMmYyyy('29/02/2025'), null);         // no bisiesto
  assert.equal(parseDdMmYyyy('31/02/2026'), null);         // día inexistente
  assert.equal(parseDdMmYyyy('31/04/2026'), null);
  assert.equal(parseDdMmYyyy('11/13/2026'), null);         // mes 13
  assert.equal(parseDdMmYyyy('00/08/2026'), null);
  assert.equal(parseDdMmYyyy('11/08/26'), null);           // año incompleto
  assert.equal(parseDdMmYyyy('11/8/2026'), null);          // falta el cero
  assert.equal(parseDdMmYyyy(''), null);
  assert.equal(parseDdMmYyyy('hola'), null);
});

test('la fecha se lee como dd/mm, nunca como mm/dd', () => {
  // El bug que motivó el cambio: 08/11/2026 es el 8 de NOVIEMBRE.
  assert.equal(parseDdMmYyyy('08/11/2026'), '2026-11-08');
  assert.equal(parseDdMmYyyy('12/01/2026'), '2026-01-12');
});

test('ida y vuelta ISO -> pantalla -> ISO', () => {
  for (const iso of ['2026-01-31', '2024-02-29', '1999-12-31', '2026-08-11']) {
    assert.equal(parseDdMmYyyy(fmtDate(iso)), iso, iso);
  }
});

test('maskDdMmYyyy va poniendo las barras al escribir', () => {
  assert.equal(maskDdMmYyyy('1'), '1');
  assert.equal(maskDdMmYyyy('11'), '11');
  assert.equal(maskDdMmYyyy('110'), '11/0');
  assert.equal(maskDdMmYyyy('1108'), '11/08');
  assert.equal(maskDdMmYyyy('11082026'), '11/08/2026');
  assert.equal(maskDdMmYyyy('110820269999'), '11/08/2026'); // no pasa de 8 dígitos
  assert.equal(maskDdMmYyyy('11/08/2026'), '11/08/2026');   // idempotente
  assert.equal(maskDdMmYyyy('11/08/202'), '11/08/202');     // al borrar no se traba
  assert.equal(maskDdMmYyyy('abc'), '');
  assert.equal(maskDdMmYyyy(''), '');
});
