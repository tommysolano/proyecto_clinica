/**
 * UN SOLO CAMPO «TELÉFONO» EN EL ALTA DE PACIENTES (client/src/utils/phone.js).
 *
 * El formulario pedía «Teléfono» y «WhatsApp» por separado y casi siempre era el
 * mismo número tecleado dos veces. Se unificó en un campo, pero los dos datos
 * siguen existiendo en la base porque TODO el envío del CRM resuelve el destino
 * como `whatsapp || phone`. Estas dos funciones son la bisagra: si se equivocan,
 * a un paciente con dos números se le cruzan o se le pierde uno.
 *
 * Vive en la suite del servidor porque el cliente no tiene corredor de tests y
 * son funciones puras (igual que dateInputFormat.test.js).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { pathToFileURL } = require('url');

const MODULE = pathToFileURL(
  path.join(__dirname, '..', '..', 'client', 'src', 'utils', 'phone.js')
).href;

let unirTelefonos;
let partirTelefonos;
test.before(async () => {
  ({ unirTelefonos, partirTelefonos } = await import(MODULE));
});

test('un solo número: se enseña tal cual y whatsapp queda vacío', () => {
  assert.equal(unirTelefonos('0991234567', ''), '0991234567');
  assert.deepEqual(partirTelefonos('0991234567'), { phone: '0991234567', whatsapp: '' });
});

test('el mismo número en los dos campos NO se enseña repetido', () => {
  assert.equal(unirTelefonos('0991234567', '0991234567'), '0991234567');
});

test('dos números distintos: se enseñan los dos y vuelven a su sitio', () => {
  const texto = unirTelefonos('0991234567', '0987654321');
  assert.equal(texto, '0991234567 / 0987654321');
  assert.deepEqual(partirTelefonos(texto), { phone: '0991234567', whatsapp: '0987654321' });
});

test('abrir y volver a guardar no cruza los números (ida y vuelta)', () => {
  const original = { phone: '042911222', whatsapp: '0999888777' };
  const vuelta = partirTelefonos(unirTelefonos(original.phone, original.whatsapp));
  assert.deepEqual(vuelta, original);
});

test('acepta otros separadores y espacios de más', () => {
  assert.deepEqual(partirTelefonos('0991234567, 0987654321'), { phone: '0991234567', whatsapp: '0987654321' });
  assert.deepEqual(partirTelefonos('0991234567 y 0987654321'), { phone: '0991234567', whatsapp: '0987654321' });
  assert.deepEqual(partirTelefonos('  0991234567  /  0987654321  '), { phone: '0991234567', whatsapp: '0987654321' });
});

test('los espacios DENTRO de un número no lo parten', () => {
  assert.deepEqual(partirTelefonos('099 123 4567'), { phone: '099 123 4567', whatsapp: '' });
  assert.deepEqual(partirTelefonos('+593 99 123 4567'), { phone: '+593 99 123 4567', whatsapp: '' });
});

test('vacío es vacío: no inventa nada', () => {
  assert.equal(unirTelefonos('', ''), '');
  assert.equal(unirTelefonos(null, undefined), '');
  assert.deepEqual(partirTelefonos(''), { phone: '', whatsapp: '' });
  assert.deepEqual(partirTelefonos('   /  '), { phone: '', whatsapp: '' });
});

test('un paciente que solo tenía WhatsApp no pierde el número', () => {
  assert.equal(unirTelefonos('', '0987654321'), '0987654321');
  // Al guardarlo pasa a ser su teléfono, y el envío lo sigue encontrando
  // (`whatsapp || phone`).
  assert.deepEqual(partirTelefonos('0987654321'), { phone: '0987654321', whatsapp: '' });
});

test('un tercer número escrito de más se ignora, no rompe el guardado', () => {
  assert.deepEqual(
    partirTelefonos('0991111111 / 0992222222 / 0993333333'),
    { phone: '0991111111', whatsapp: '0992222222' }
  );
});
