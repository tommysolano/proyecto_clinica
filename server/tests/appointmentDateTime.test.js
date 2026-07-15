/**
 * appointmentDateTime: combina el día calendario de la cita (`date`) con su hora
 * de inicio (`startTime`) en la hora REAL de la cita en Ecuador (UTC-5 fijo).
 * Es la base de los pasos "esperar hasta la cita" de los workflows: con solo
 * `date` (guardada a las 12:00) el recordatorio salía a una hora que no era.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { appointmentDateTime } = require('../utils/appointmentDate');

test('combina el día (guardado a las 12:00 local) con startTime en hora Ecuador', () => {
  // Forma actual de guardado: 12:00 hora local Ecuador = 17:00Z.
  const stored = new Date('2026-07-20T17:00:00.000Z');
  const dt = appointmentDateTime(stored, '10:00');
  assert.equal(dt.toISOString(), '2026-07-20T15:00:00.000Z'); // 10:00 -05:00
});

test('también respeta el día con el guardado legacy a medianoche UTC', () => {
  const legacy = new Date('2026-07-20T00:00:00.000Z');
  const dt = appointmentDateTime(legacy, '08:30');
  assert.equal(dt.toISOString(), '2026-07-20T13:30:00.000Z'); // 08:30 -05:00
});

test('sin startTime válido devuelve la fecha tal cual (no rompe)', () => {
  const stored = new Date('2026-07-20T17:00:00.000Z');
  assert.equal(appointmentDateTime(stored, '').getTime(), stored.getTime());
  assert.equal(appointmentDateTime(stored, 'x').getTime(), stored.getTime());
  assert.equal(appointmentDateTime(stored, null).getTime(), stored.getTime());
});

test('entrada inválida devuelve null', () => {
  assert.equal(appointmentDateTime(null, '10:00'), null);
  assert.equal(appointmentDateTime('no-es-fecha', '10:00'), null);
});

test('acepta hora con un solo dígito (9:05)', () => {
  const stored = new Date('2026-07-20T17:00:00.000Z');
  assert.equal(appointmentDateTime(stored, '9:05').toISOString(), '2026-07-20T14:05:00.000Z');
});
