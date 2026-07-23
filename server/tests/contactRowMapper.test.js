/**
 * Mapeo de filas → contacto. La columna "Hora" del Excel es la hora de la CITA (una
 * VARIABLE de la plantilla, {{hora}}), NO la hora de envío de la campaña: se propone
 * como campo personalizado, no como disparo. La hora de disparo se decide al importar
 * (sendMode/sendAt), no por columna. `parseSendTime` sigue existiendo (defensivo) y se
 * prueba aparte.
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

test('guessField: "Hora"/"Horario" se proponen como VARIABLE (custom), no como hora de envío', () => {
  // En un archivo de recordatorios "Hora" es la hora de la CITA (variable {{hora}}),
  // no la hora de disparo. Auto-mapearla a envío retrasaba toda la campaña a mañana.
  assert.equal(guessField('Hora'), 'custom:hora');
  assert.equal(guessField('Horario'), 'custom:horario');
  assert.equal(guessField('Fecha'), 'custom:fecha');
  assert.equal(guessField('Doctor'), 'custom:doctor');
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

test('mapRow: custom:hora normaliza la fracción de Excel a HH:MM; otras columnas decimales NO se tocan', () => {
  const r = mapRow(
    { Celular: '0999111222', Hora: '1.3333333333321207', Precio: '0.15' },
    [
      { column: 'Celular', field: 'phone' },
      { column: 'Hora', field: 'custom:hora' },
      { column: 'Precio', field: 'custom:precio' },
    ]
  );
  assert.equal(r.ok, true);
  assert.equal(r.contact.customFields.hora, '08:00', 'la hora sí se normaliza (clave de hora)');
  assert.equal(r.contact.customFields.precio, '0.15', 'un decimal cualquiera se conserva intacto');
});

test('mapRow: la columna Hora (hora de la cita) se guarda como variable en customFields', () => {
  // El lector (cellText) ya normaliza la fracción de Excel a "08:00" antes de llegar
  // aquí; mapRow solo la guarda como dato del contacto para usarla de variable.
  const r = mapRow(
    { Celular: '0999111222', Hora: '08:00' },
    [
      { column: 'Celular', field: 'phone' },
      { column: 'Hora', field: 'custom:hora' },
    ]
  );
  assert.equal(r.ok, true);
  assert.equal(r.contact.phone, '593999111222');
  assert.equal(r.contact.customFields.hora, '08:00', 'la hora de la cita queda como variable {{hora}}');
});
