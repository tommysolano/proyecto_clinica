/**
 * Mapeo de filas → contacto, con foco en la HORA de envío (`sendTime`): el usuario
 * escribe la hora en el Excel y el sistema debe entenderla venga como "8:00", como
 * hora entera o como la fracción de día de Excel (0,3333) que causaba los
 * "demasiados decimales".
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseSendTime, mapRow, guessField } = require('../utils/contactRowMapper');

test('parseSendTime: entiende texto, hora entera y am/pm', () => {
  assert.equal(parseSendTime('8:00'), '08:00');
  assert.equal(parseSendTime('14:30'), '14:30');
  assert.equal(parseSendTime('8'), '08:00');
  assert.equal(parseSendTime('8 am'), '08:00');
  assert.equal(parseSendTime('2:30 pm'), '14:30');
  assert.equal(parseSendTime('12 am'), '00:00');
  assert.equal(parseSendTime('12 pm'), '12:00');
});

test('parseSendTime: la fracción de día de Excel (los "decimales") se vuelve HH:MM', () => {
  // 8:00 = 8/24 = 0.3333…  ·  14:00 = 14/24 = 0.5833…
  assert.equal(parseSendTime('0.3333333333333333'), '08:00');
  assert.equal(parseSendTime('0.5833333333333334'), '14:00');
  assert.equal(parseSendTime('0,5'), '12:00'); // coma decimal (locale español)
  // Un serial completo (fecha+hora) también da su hora.
  assert.equal(parseSendTime('45000.5833333'), '14:00');
});

test('parseSendTime: hora ya formateada como fecha (celda Date del lector)', () => {
  assert.equal(parseSendTime('1899-12-31T08:00:00.000Z'), '08:00');
  assert.equal(parseSendTime('2026-07-22 14:30'), '14:30');
});

test('parseSendTime: basura → cadena vacía', () => {
  assert.equal(parseSendTime(''), '');
  assert.equal(parseSendTime('mañana'), '');
  assert.equal(parseSendTime('25:00'), ''); // hora imposible
  assert.equal(parseSendTime(null), '');
});

test('guessField: una columna "Hora" se propone como sendTime', () => {
  assert.equal(guessField('Hora'), 'sendTime');
  assert.equal(guessField('Hora de envío'), 'sendTime');
  assert.equal(guessField('Horario'), 'sendTime');
});

test('guessField: "Agencia"/"Oficina" se reconocen como Sucursal (cada clínica nombra sus sedes distinto)', () => {
  assert.equal(guessField('Agencia'), 'clinic');
  assert.equal(guessField('Oficina'), 'clinic');
  assert.equal(guessField('Sucursal'), 'clinic');
  assert.equal(guessField('Sede'), 'clinic');
});

test('guessField: columnas de datos (Servicio, Ciudad…) se proponen como campo personalizado, no "No importar"', () => {
  assert.equal(guessField('Servicio'), 'custom:servicio');
  assert.equal(guessField('Programa'), 'custom:programa');
  assert.equal(guessField('Ciudad'), 'custom:ciudad');
  assert.equal(guessField('Especialidad'), 'custom:especialidad');
  // Una columna sin sentido reconocible sigue en "No importar" (cadena vacía).
  assert.equal(guessField('xyz123'), '');
});

test('mapRow: "Servicio" auto-mapeado a custom guarda el valor en customFields', () => {
  const r = mapRow(
    { Phone: '0999111222', Servicio: 'Programa Prostata' },
    [
      { column: 'Phone', field: 'phone' },
      { column: 'Servicio', field: 'custom:servicio' },
    ]
  );
  assert.equal(r.ok, true);
  assert.equal(r.contact.customFields.servicio, 'Programa Prostata');
});

test('mapRow: la hora se guarda en sendTime (no como campo del contacto)', () => {
  const r = mapRow(
    { Celular: '0999111222', Hora: '0.3333333' },
    [
      { column: 'Celular', field: 'phone' },
      { column: 'Hora', field: 'sendTime' },
    ]
  );
  assert.equal(r.ok, true);
  assert.equal(r.contact.phone, '593999111222');
  assert.equal(r.contact.sendTime, '08:00', 'la fracción de Excel quedó en HH:MM');
});
