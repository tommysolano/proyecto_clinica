/**
 * appointmentDateTime: combina el día calendario de la cita (`date`) con su hora
 * de inicio (`startTime`) en la hora REAL de la cita en Ecuador (UTC-5 fijo).
 * Es la base de los pasos "esperar hasta la cita" de los workflows: con solo
 * `date` (guardada a las 12:00) el recordatorio salía a una hora que no era.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { appointmentDateTime, isPastLocalDateTime } = require('../utils/appointmentDate');
const { isNoShowDue } = require('../utils/autoNoShow');

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

// ─────────── isPastLocalDateTime (bloqueo de agendar en hora pasada) ───────────

test('isPastLocalDateTime: HOY con hora anterior a la actual ya pasó', () => {
  const now = new Date(2026, 6, 15, 16, 15); // 15-jul 16:15 local
  const today = new Date(2026, 6, 15, 12, 0);
  assert.equal(isPastLocalDateTime(today, '09:00', now), true);
  assert.equal(isPastLocalDateTime(today, '16:14', now), true);
  assert.equal(isPastLocalDateTime(today, '16:15', now), false); // el minuto en curso aún vale
  assert.equal(isPastLocalDateTime(today, '17:00', now), false);
});

test('isPastLocalDateTime: días completos y casos sin hora', () => {
  const now = new Date(2026, 6, 15, 16, 15);
  assert.equal(isPastLocalDateTime(new Date(2026, 6, 14, 12, 0), '23:59', now), true); // ayer, cualquier hora
  assert.equal(isPastLocalDateTime(new Date(2026, 6, 16, 12, 0), '00:00', now), false); // mañana
  assert.equal(isPastLocalDateTime(new Date(2026, 6, 15, 12, 0), '', now), false); // hoy sin hora: lo valida el caller
  assert.equal(isPastLocalDateTime(null, '09:00', now), false);
});

// ─────────── isNoShowDue (no-show automático de citas de HOY) ───────────

test('isNoShowDue: la cita vence apenas pasa su hora de inicio (margen de 1 min)', () => {
  const date = new Date('2026-07-15T17:00:00Z'); // día guardado a las 12:00 hora Ecuador
  const appt = { date, startTime: '16:35' };
  assert.equal(isNoShowDue(appt, new Date('2026-07-15T16:35:30-05:00')), false); // dentro del margen
  assert.equal(isNoShowDue(appt, new Date('2026-07-15T16:37:00-05:00')), true); // pasó la hora → no-show

  // La hora de FIN no pospone el no-show: si nadie la recibió al inicio, venció.
  const withEnd = { date, startTime: '16:35', endTime: '17:30' };
  assert.equal(isNoShowDue(withEnd, new Date('2026-07-15T16:37:00-05:00')), true);
});

test('isNoShowDue: sin hora de inicio válida no se marca (queda para el barrido del día siguiente)', () => {
  const date = new Date('2026-07-15T17:00:00Z');
  assert.equal(isNoShowDue({ date, startTime: '' }, new Date('2026-07-16T10:00:00-05:00')), false);
  assert.equal(isNoShowDue({ date, startTime: 'x' }, new Date('2026-07-16T10:00:00-05:00')), false);
});
