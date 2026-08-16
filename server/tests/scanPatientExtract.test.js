/**
 * Lectura de fichas físicas escaneadas (utils/scanPatientExtract.js).
 *
 * Aquí se prueba la BARRERA DE VALIDACIÓN: la que decide qué dato se guarda y qué
 * dato se marca para revisar. Da igual quién transcriba el papel — es letra
 * manuscrita, así que la regla de fondo es una sola: ante la duda, marcar y no
 * inventar. Una cédula mal leída no da un error, da un paciente equivocado.
 */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cedulaValida,
  parseFechaEc,
  normalizarCelular,
  normalizarExtraccion,
} = require('../utils/scanPatientExtract');

// ───────────────────────────── Cédula ─────────────────────────────

test('C1) la cédula se valida con el dígito verificador, no solo por longitud', () => {
  // Cédulas reales de las capturas del usuario.
  assert.equal(cedulaValida('0905103495'), true);
  assert.equal(cedulaValida('0917339210'), true);
  // Mismo número con un dígito cambiado: 10 dígitos, pero no cuadra.
  assert.equal(cedulaValida('0905103496'), false, 'un dígito mal leído se detecta');
  assert.equal(cedulaValida('0905103485'), false);
  // Ojo: en la base real hay cédulas cargadas a mano que NO pasan el verificador
  // (p. ej. 0911972775). Por eso el saneador las conserva y las marca en vez de
  // descartarlas: rechazarlas perdería un dato que casi siempre está bien leído.
  assert.equal(cedulaValida('0911972775'), false);
});

test('C2) descarta longitudes, provincias y tipos imposibles', () => {
  assert.equal(cedulaValida('091733921'), false, '9 dígitos');
  assert.equal(cedulaValida('09173392101'), false, '11 dígitos');
  assert.equal(cedulaValida('9917339210'), false, 'provincia 99 no existe');
  assert.equal(cedulaValida('0017339210'), false, 'provincia 00 no existe');
  assert.equal(cedulaValida('0967339210'), false, 'tercer dígito 6+ no es persona natural');
  assert.equal(cedulaValida(''), false);
  assert.equal(cedulaValida(null), false);
});

// ───────────────────────────── Fecha ─────────────────────────────

test('F1) lee las fechas como se escriben a mano en la ficha', () => {
  // "1-06-26" es lo que está escrito en la ficha de la captura.
  const f = parseFechaEc('1-06-26');
  assert.equal(f.getFullYear(), 2026);
  assert.equal(f.getMonth(), 5, 'junio');
  assert.equal(f.getDate(), 1);
  assert.equal(f.getHours(), 12, 'a mediodía: así el huso horario no la mueve un día');

  assert.equal(parseFechaEc('29/04/1955').getFullYear(), 1955);
  assert.equal(parseFechaEc('01.06.2026').getDate(), 1);
  assert.equal(parseFechaEc('15 / 3 / 2026').getMonth(), 2);
});

test('F2) es dd/mm (Ecuador), no mm/dd', () => {
  const f = parseFechaEc('04/09/2026');
  assert.equal(f.getDate(), 4);
  assert.equal(f.getMonth(), 8, 'septiembre, no abril');
});

test('F3) rechaza fechas imposibles en vez de "corregirlas"', () => {
  // Date() convertiría 31/02 en 03/03 sin avisar: eso sería inventar un dato.
  assert.equal(parseFechaEc('31/02/2026'), null);
  assert.equal(parseFechaEc('00/06/2026'), null);
  assert.equal(parseFechaEc('15/13/2026'), null);
  assert.equal(parseFechaEc('1-06-2200'), null, 'año futuro');
  assert.equal(parseFechaEc('garabato'), null);
  assert.equal(parseFechaEc(''), null);
});

// ───────────────────────────── Celular ─────────────────────────────

test('T1) normaliza el celular escrito de cualquier forma', () => {
  assert.equal(normalizarCelular('0994967491'), '0994967491');
  assert.equal(normalizarCelular('099 496 7491'), '0994967491');
  assert.equal(normalizarCelular('+593 99 496 7491'), '0994967491');
  assert.equal(normalizarCelular('994967491'), '0994967491', 'le faltaba el 0');
  assert.equal(normalizarCelular('042345678'), '042345678', 'fijo de Guayaquil');
});

test('T2) descarta lo que no puede ser un teléfono', () => {
  assert.equal(normalizarCelular('12345'), '');
  assert.equal(normalizarCelular('0194967491'), '', 'no existe el operador 01');
  assert.equal(normalizarCelular(''), '');
});

// ─────────────────────── Normalización completa ───────────────────────

test('N1) una ficha bien leída no deja ninguna duda', () => {
  const r = normalizarExtraccion({
    fecha: '1-06-26',
    nombres: 'José',
    apellidos: 'Cuzco Espinoza',
    cedula: '0905103495',
    edad: '71',
    celular: '0994967491',
    correo: 'JOSECUZCOESPINOZA@GMAIL.COM',
    direccion: 'Barrio Garay',
    dudosos: [],
  });

  assert.deepEqual(r.dudas, []);
  assert.equal(r.utilizable, true);
  assert.equal(r.datos.cedula, '0905103495');
  assert.equal(r.datos.edad, 71);
  assert.equal(r.datos.correo, 'josecuzcoespinoza@gmail.com', 'el correo se normaliza a minúsculas');
  assert.equal(r.datos.fecha.getFullYear(), 2026);
});

test('N2) lo que no pasa la validación se marca, no se guarda a medias', () => {
  const r = normalizarExtraccion({
    fecha: '99/99/9999',
    nombres: 'María',
    apellidos: 'Pérez',
    cedula: '0905103496',      // 10 dígitos pero el verificador no cuadra
    edad: '250',
    celular: '12345',
    correo: 'esto no es correo',
    direccion: 'Av. Principal',
    dudosos: [],
  });

  assert.equal(r.datos.cedula, '0905103496', 'se conserva, pero marcada para revisar');
  assert.equal(r.datos.fecha, null);
  assert.equal(r.datos.edad, null);
  assert.equal(r.datos.celular, '');
  assert.equal(r.datos.correo, '');
  for (const campo of ['cedula', 'fecha', 'edad', 'celular', 'correo']) {
    assert.ok(r.dudas.includes(campo), `${campo} debe quedar marcado para revisar`);
  }
  // Lo leído se conserva para poder compararlo con el PDF al revisar.
  assert.equal(r.crudo.cedula, '0905103496');
});

test('N3) las dudas de quien transcribe se suman a las de la validación, sin repetirse', () => {
  const r = normalizarExtraccion({
    fecha: '1-06-26',
    nombres: 'Ana',
    apellidos: 'Solís',
    cedula: '0905103496',                 // inválida → duda por validación
    edad: '30',
    celular: '0994967491',
    correo: 'ana@correo.com',
    direccion: '',
    dudosos: ['cedula', 'direccion'],     // además se dudó de la dirección
  });

  assert.equal(r.dudas.filter((d) => d === 'cedula').length, 1, 'sin duplicar');
  assert.ok(r.dudas.includes('direccion'), 'se respeta la duda reportada al transcribir');
});

test('N4) un campo vacío en la ficha no es una duda; uno ilegible sí', () => {
  const vacio = normalizarExtraccion({
    fecha: '', nombres: 'Ana', apellidos: 'Solís', cedula: '', edad: '',
    celular: '', correo: '', direccion: '', dudosos: [],
  });
  assert.deepEqual(vacio.dudas, [], 'la ficha simplemente no traía esos datos');

  const ilegible = normalizarExtraccion({
    fecha: '', nombres: 'Ana', apellidos: 'Solís', cedula: '09051034',
    edad: '', celular: '', correo: '', direccion: '', dudosos: [],
  });
  assert.ok(ilegible.dudas.includes('cedula'), 'había algo escrito y no se pudo validar');
  assert.equal(ilegible.datos.cedula, '', 'incompleta: no se guarda, para no chocar con la clave única');
});

test('N5) sin nombre ni apellido la ficha no sirve para registrar', () => {
  const r = normalizarExtraccion({
    fecha: '1-06-26', nombres: '', apellidos: '', cedula: '0905103495',
    edad: '40', celular: '', correo: '', direccion: '', dudosos: [],
  });
  assert.equal(r.utilizable, false);
  assert.ok(r.dudas.includes('nombres'));
  assert.ok(r.dudas.includes('apellidos'));
});
